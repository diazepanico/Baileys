import { Boom } from '@hapi/boom'
import { createHash } from 'crypto'
import { proto } from '../../WAProto'
import { KEY_BUNDLE_TYPE } from '../Defaults'
import type { AuthenticationCreds, SignalCreds, SocketConfig } from '../Types'
import { BinaryNode, getBinaryNodeChild, jidDecode, S_WHATSAPP_NET } from '../WABinary'
import { Curve, hmacSign } from './crypto'
import { encodeBigEndian } from './generics'
import { createSignalIdentity } from './signal'

const getUserAgent = (config: SocketConfig): proto.ClientPayload.IUserAgent => {
	const osVersion = '15.3.1'
	return {
		appVersion: {
			primary: 2,
			secondary: 22,
			tertiary: 24,
			quaternary: 81
		},
		platform: proto.ClientPayload.UserAgent.Platform.IOS,
		releaseChannel: proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
		mcc: config.registration?.phoneNumberMobileCountryCode || '000',
		mnc: config.registration?.phoneNumberMobileNetworkCode || '000',
		osVersion: osVersion,
		manufacturer: 'Apple',
		device: 'iPhone_7',
		osBuildNumber: osVersion,
		localeLanguageIso6391: 'en',
		localeCountryIso31661Alpha2: 'US',
		phoneId: config.auth.creds.phoneId,
	}
}

const PLATFORM_MAP = {
	'Mac OS': proto.ClientPayload.WebInfo.WebSubPlatform.DARWIN,
	'Windows': proto.ClientPayload.WebInfo.WebSubPlatform.WIN32
}

const getWebInfo = (config: SocketConfig): proto.ClientPayload.IWebInfo => {
	let webSubPlatform = proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER
	if(config.syncFullHistory && PLATFORM_MAP[config.browser[0]]) {
		webSubPlatform = PLATFORM_MAP[config.browser[0]]
	}

	return { webSubPlatform }
}

const getClientPayload = (config: SocketConfig) => {
	const payload: proto.IClientPayload = {
		connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
		connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
		userAgent: getUserAgent(config),
	}

	if(!config.mobile) {
		payload.webInfo = getWebInfo(config)
	}

	return payload
}

export const generateAuthenticationNode = (config: SocketConfig): proto.IClientPayload => {
	if(!config.registration) {
		throw new Boom('No registration data found', { data: config })
	}

	const payload: proto.IClientPayload = {
		...getClientPayload(config),
		sessionId: Math.floor(Math.random() * 999999999 + 1),
		shortConnect: true,
		connectAttemptCount: 0,
		device: 0,
		dnsSource: {
			appCached: false,
			dnsMethod: proto.ClientPayload.DNSSource.DNSResolutionMethod.SYSTEM,
		},
		passive: false, // XMPP heartbeat setting (false: server actively pings) (true: client actively pings)
		pushName: 'test',
		username: Number(`${config.registration?.phoneNumberCountryCode}${config.registration?.phoneNumberNationalNumber}`),
	}
	return proto.ClientPayload.fromObject(payload)
}

export const generateLoginNode = (userJid: string, config: SocketConfig): proto.IClientPayload => {
	const { user, device } = jidDecode(userJid)!
	const payload: proto.IClientPayload = {
		...getClientPayload(config),
		passive: true,
		username: +user,
		device: device,
	}
	return proto.ClientPayload.fromObject(payload)
}

export const generateRegistrationNode = (
	{ registrationId, signedPreKey, signedIdentityKey }: SignalCreds,
	config: SocketConfig
) => {
	// the app version needs to be md5 hashed
	// and passed in
	const appVersionBuf = createHash('md5')
		.update(config.version.join('.')) // join as string
		.digest()
	const browserVersion = config.browser[2].split('.')

	const companion: proto.IDeviceProps = {
		os: config.browser[0],
		version: {
			primary: +(browserVersion[0] || 0),
			secondary: +(browserVersion[1] || 1),
			tertiary: +(browserVersion[2] || 0),
		},
		platformType: proto.DeviceProps.PlatformType[config.browser[1].toUpperCase()]
			|| proto.DeviceProps.PlatformType.UNKNOWN,
		requireFullSync: config.syncFullHistory,
	}

	const companionProto = proto.DeviceProps.encode(companion).finish()

	const registerPayload: proto.IClientPayload = {
		...getClientPayload(config),
		passive: false,
		devicePairingData: {
			buildHash: appVersionBuf,
			deviceProps: companionProto,
			eRegid: encodeBigEndian(registrationId),
			eKeytype: KEY_BUNDLE_TYPE,
			eIdent: signedIdentityKey.public,
			eSkeyId: encodeBigEndian(signedPreKey.keyId, 3),
			eSkeyVal: signedPreKey.keyPair.public,
			eSkeySig: signedPreKey.signature,
		},
	}

	return proto.ClientPayload.fromObject(registerPayload)
}

export const configureSuccessfulPairing = (
	stanza: BinaryNode,
	{ advSecretKey, signedIdentityKey, signalIdentities }: Pick<AuthenticationCreds, 'advSecretKey' | 'signedIdentityKey' | 'signalIdentities'>
) => {
	const msgId = stanza.attrs.id

	const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success')

	const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity')
	const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform')
	const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device')
	const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz')

	if(!deviceIdentityNode || !deviceNode) {
		throw new Boom('Missing device-identity or device in pair success node', { data: stanza })
	}

	const bizName = businessNode?.attrs.name
	const jid = deviceNode.attrs.jid

	const { details, hmac } = proto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content as Buffer)
	// check HMAC matches
	const advSign = hmacSign(details, Buffer.from(advSecretKey, 'base64'))
	if(Buffer.compare(hmac, advSign) !== 0) {
		throw new Boom('Invalid account signature')
	}

	const account = proto.ADVSignedDeviceIdentity.decode(details)
	const { accountSignatureKey, accountSignature, details: deviceDetails } = account
	// verify the device signature matches
	const accountMsg = Buffer.concat([ Buffer.from([6, 0]), deviceDetails, signedIdentityKey.public ])
	if(!Curve.verify(accountSignatureKey, accountMsg, accountSignature)) {
		throw new Boom('Failed to verify account signature')
	}

	// sign the details with our identity key
	const deviceMsg = Buffer.concat([ Buffer.from([6, 1]), deviceDetails, signedIdentityKey.public, accountSignatureKey ])
	account.deviceSignature = Curve.sign(signedIdentityKey.private, deviceMsg)

	const identity = createSignalIdentity(jid, accountSignatureKey)
	const accountEnc = encodeSignedDeviceIdentity(account, false)

	const deviceIdentity = proto.ADVDeviceIdentity.decode(account.details)

	const reply: BinaryNode = {
		tag: 'iq',
		attrs: {
			to: S_WHATSAPP_NET,
			type: 'result',
			id: msgId,
		},
		content: [
			{
				tag: 'pair-device-sign',
				attrs: { },
				content: [
					{
						tag: 'device-identity',
						attrs: { 'key-index': deviceIdentity.keyIndex.toString() },
						content: accountEnc
					}
				]
			}
		]
	}

	const authUpdate: Partial<AuthenticationCreds> = {
		account,
		me: { id: jid, name: bizName },
		signalIdentities: [
			...(signalIdentities || []),
			identity
		],
		platform: platformNode?.attrs.name
	}

	return {
		creds: authUpdate,
		reply
	}
}

export const encodeSignedDeviceIdentity = (
	account: proto.IADVSignedDeviceIdentity,
	includeSignatureKey: boolean
) => {
	account = { ...account }
	// set to null if we are not to include the signature key
	// or if we are including the signature key but it is empty
	if(!includeSignatureKey || !account.accountSignatureKey?.length) {
		account.accountSignatureKey = null
	}

	const accountEnc = proto.ADVSignedDeviceIdentity
		.encode(account)
		.finish()
	return accountEnc
}