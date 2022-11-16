import { existsSync, mkdirSync } from 'fs'
import { readdir, unlink, writeFile } from 'fs/promises'
import path from 'node:path'
import { Logger } from 'pino'
import { BaileysBufferableEventEmitter } from './event-buffer'

const pathFile = '/tmp/scheduleNodes'

const createFileName = (id: string, timestamp: Date) => {
	return `${pathFile}/${id}-${timestamp.getTime()}.msg`
}

const matchFileName = (fileName: string) => {
	const f = fileName.split('/')
	return f[f.length - 1].match(/(.+)\-(\d+)\.msg/)
}

const scheduleNodeSave = async(id: string, timestamp: Date, data: Uint8Array | Buffer) => {
	const fileName = createFileName(id, timestamp)
	await writeFile(fileName, data)
}

const scheduleNodeGet = async() => {
	return (await readdir(pathFile)).map((f) => `${pathFile}/${f}`)
}

export interface WaScheduleNodeData{
    timestamp: Date;
    id: string;
    fileNode: string;
};

export class ScheduleNode {

	private _data: WaScheduleNodeData[] = []
	private _ev?: BaileysBufferableEventEmitter
	private _logger?: Logger
	private _timer: NodeJS.Timeout

	constructor(config?: {logger: Logger, ev: BaileysBufferableEventEmitter}) {
		if (!existsSync(pathFile)) {
			mkdirSync(pathFile, { recursive: true })
		}
		this._logger = config?.logger
		this._ev = config?.ev
		scheduleNodeGet().then((files) => {
			files.map((file) => {
				const d = this.parseFileName(file)
				if(d) {
					this._data.push(d)
				}
			})
			this._logger?.info({ files: this._data }, 'Load nodes pending')
		})
	}

	start() {
		this._timer = setInterval(this._checkNodeReady.bind(this), 1_000)
	}

	private parseFileName(file: string): WaScheduleNodeData | undefined {
		const groups = matchFileName(file)

		if(!groups) {
			return
		}

		return {
			timestamp: new Date(Number(groups[2])),
			id: groups[1],
			fileNode: file
		}

	}

	private _nodeIsReady(c: WaScheduleNodeData): boolean {
    	const now = new Date()
    	return now > c.timestamp
	}


	get nodes() {
		return this._data
	}

	async saveNode(id: string, timestamp: Date, data: Uint8Array | Buffer) {

		if(isNaN(timestamp.getTime())) {
			throw new Error('Timestamp invalid in ScheduleNode')
		}

		if(!id) {
			throw new Error('ID invalid in ScheduleNode')
		}

		const node = {
			timestamp,
			id,
			fileNode: createFileName(id, timestamp)
		}
		await scheduleNodeSave(id, timestamp, data)
		this._logger?.info({ node }, 'Save node')
		this._data.push(node)
	}

	async removeNode(node: WaScheduleNodeData) {

		const nodeIndex = this._data.findIndex((n) => n.id === node.id)

		if(nodeIndex > -1) {
			this._data.splice(nodeIndex, 1)
		}

		try {
			await unlink(node.fileNode)
		} catch(err) {
			this._logger?.error({ err }, 'Error in unlink file')
		}

	}

	async removeAll() {
		this._data = []
		for(const file of await readdir(pathFile)) {
			await unlink(path.join(pathFile, file))
		}
	}

	private _getNodeReady() {
		const nodes = this._data.filter(d => this._nodeIsReady(d))
		const files = nodes.map(d => d.fileNode)
		this._data = this._data.filter(d => !files.includes(d.fileNode))
		return nodes
	}

	private _checkNodeReady() {
		const nodes = this._getNodeReady()
		if(nodes.length) {
			this._ev?.emit('schedule-node.send', { nodes })
		}
	}

	stop() {
    	clearInterval(this._timer)
	}
}
