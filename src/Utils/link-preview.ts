import { AxiosRequestConfig } from 'axios'
import MD5 from 'crypto-js/md5'

import { Logger } from 'pino'
import { WAMediaUploadFunction, WAUrlInfo } from '../Types'
import { prepareWAMessageMedia } from './messages'
import { extractImageThumb, getHttpStream } from './messages-media'

const THUMBNAIL_WIDTH_PX = 192
let previewLink: any

/** Fetches an image and generates a thumbnail for it */
const getCompressedJpegThumbnail = async(
	url: string,
	{ thumbnailWidth, fetchOpts }: URLGenerationOptions
) => {
	const stream = await getHttpStream(url, fetchOpts)
	const result = await extractImageThumb(stream, thumbnailWidth)
	return result
}

const fetchImageWithAxios = async(url: string, previewLink: any) => {
	const { default: axios } = await import('axios')
	let fetched: any
	try {
		url = url.toString()
		if(url.includes('data:image')) {
			throw new Error('Includes data image ' + url)
		}

		fetched = await axios.get(url, { responseType: 'arraybuffer' })
		return fetched.data
	} catch(error) {
		fetched = await axios.get('https://redirectmais.com/assets/images/sample-whatsapp.jpg', { responseType: 'arraybuffer' })
		return fetched.data
	}
}

export type URLGenerationOptions = {
	thumbnailWidth: number
	fetchOpts: {
		/** Timeout in ms */
		timeout: number
		proxyUrl?: string
		headers?: AxiosRequestConfig<{}>['headers']
	}
	uploadImage?: WAMediaUploadFunction
	logger?: Logger
}

/**
 * Given a piece of text, checks for any URL present, generates link preview for the same and returns it
 * Return undefined if the fetch failed or no URL was found
 * @param text first matched URL in text
 * @returns the URL info required to generate link preview
 */
export const getUrlInfo = async(
	text: string,
	opts: URLGenerationOptions = {
		thumbnailWidth: THUMBNAIL_WIDTH_PX,
		fetchOpts: { timeout: 3000 }
	}, myCache: any
): Promise<WAUrlInfo | undefined> => {
	try {
		const { getLinkPreview } = await import('link-preview-js')
		let previewLink = text
		if(!text.startsWith('https://') && !text.startsWith('http://')) {
			previewLink = 'https://' + previewLink
		}

		var info: any

		if(myCache) {
			info = myCache.get(MD5(previewLink).toString())
			if(info == 'not avaliable') {
				return undefined
			}

			if(info == undefined || info == null) {
				info = await getLinkPreview(previewLink, { followRedirects: 'follow', timeout: 13000 })
				myCache.set(MD5(previewLink).toString(), info)
			}
		} else {
			info = await getLinkPreview(previewLink, { followRedirects: 'follow', timeout: 3000 })
		}

		if(info) {
			const [image] = info.images

			const urlInfo: WAUrlInfo = {
				'canonical-url': info.url,
				'matched-text': text,
				title: info.title,
				description: info.description,
				originalThumbnailUrl: image
			}

			if(opts.uploadImage) {
				let buffer: any

				if(myCache) {
					buffer = myCache.get(MD5(previewLink + '_image_buffer').toString())
					if(buffer == undefined || buffer == null) {

						buffer = await fetchImageWithAxios(image, previewLink)
						myCache.set(MD5(previewLink + '_image_buffer').toString(), buffer)
					}
				}

				let result: any
				if(buffer) {
					result = buffer
				} else {
					result = { url: image }
				}

				const { imageMessage } = await prepareWAMessageMedia(
					{ image: result },
					{ upload: opts.uploadImage, mediaTypeOverride: 'thumbnail-link', options: opts.fetchOpts }
				)

				urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail
					? Buffer.from(imageMessage.jpegThumbnail)
					: undefined
				urlInfo.highQualityThumbnail = imageMessage || undefined
			} else {
				try {
					urlInfo.jpegThumbnail = image
						? (await getCompressedJpegThumbnail(image, opts)).buffer
						: undefined
				} catch(error) {
					opts.logger?.debug(
						{ err: error.stack, url: previewLink },
						'error in generating thumbnail'
					)
				}
			}

			return urlInfo
		}
	} catch(error) {
		if(myCache) {
			myCache.set(MD5(previewLink).toString(), 'not avaliable')
		}
		
		if(!error.message.includes('receive a valid')) {
			throw error
		}
	}
}