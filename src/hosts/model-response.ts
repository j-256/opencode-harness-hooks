import { HookServiceError, runService, UnsupportedServiceError } from '../service-execution.js'
import { EXECUTION_LIMITS } from '../runner.js'
import { ModelApiError } from '../model-artifact.js'

const COLLECTOR = 'StructuredOutput'
const WIRE_OVERHEAD = 8
const MAX_BLOCKS = 128
const CONTENT_TYPE = 'content-type'
interface Block { name: string; raw: string }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function invalid(): never { throw new HookServiceError('MODEL_RESPONSE_INVALID') }

export async function modelApiFailure(response: Response, signal: AbortSignal): Promise<ModelApiError> {
  return runService(null, signal, async current => {
    const reader = response.body?.getReader()
    if (!reader) throw new UnsupportedServiceError('HOST_MODEL_API_ERROR_UNAVAILABLE')
    const cancel = () => { void reader.cancel().catch(() => {}) }
    current.addEventListener('abort', cancel, { once: true })
    try {
      let bytes = 0
      const chunks: Uint8Array[] = []
      while (true) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > EXECUTION_LIMITS.outputBytes) throw new HookServiceError('EXECUTION_OUTPUT_LIMIT')
        chunks.push(next.value)
      }
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw new UnsupportedServiceError('HOST_MODEL_API_ERROR_UNAVAILABLE') }
      if (!record(value) || !record(value.error) || typeof value.error.message !== 'string') throw new UnsupportedServiceError('HOST_MODEL_API_ERROR_UNAVAILABLE')
      return new ModelApiError('Hook evaluator API error: API Error: ' + response.status + ' ' + value.error.message)
    } finally { current.removeEventListener('abort', cancel); cancel() }
  })
}

export class ModelResponse {
  private readonly blocks = new Map<string, Block>()
  private text = ''
  private bytes = 0
  private pending = ''
  private data: string[] = []
  private failure: unknown
  private used = false
  private complete = false

  constructor(private readonly limit = EXECUTION_LIMITS.outputBytes) {}
  raw(): string {
    if (this.failure) throw this.failure
    if (!this.complete) throw new HookServiceError('MODEL_RESPONSE_INCOMPLETE')
    const blocks = [...this.blocks.values()]
    if (blocks.length > 1 || blocks.some(block => block.name !== COLLECTOR)) invalid()
    return blocks.length ? blocks[0]!.raw : this.text
  }
  wrap(response: Response, signal: AbortSignal): Response {
    if (this.used || !response.body) invalid()
    this.used = true
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
    const streaming = response.headers.get(CONTENT_TYPE)?.split(';')[0]?.trim() === 'text/event-stream'
    let finished = false
    const stop = () => { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}) }
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const fail = (error: unknown) => { if (finished) return; finished = true; this.failure = error; this.pending = ''; this.data = []; this.text = ''; this.blocks.clear(); stop(); controller.error(error) }
    const abort = () => fail(new HookServiceError('EXECUTION_CANCELLED'))
    const stream = new ReadableStream<Uint8Array>({
      start(current) { controller = current },
      pull: async current => {
        if (finished) return
        try {
          if (signal.aborted) return abort()
          const next = await reader.read()
          if (finished) return
          if (next.done) {
            this.consume(decoder.decode(), streaming)
            if (streaming) { this.line(this.pending); this.pending = ''; this.flush() }
            else { this.json(JSON.parse(this.pending)); this.pending = '' }
            this.complete = true; this.raw(); finished = true; stop(); current.close()
          } else {
            this.bytes += next.value.byteLength
            if (this.bytes > this.limit * WIRE_OVERHEAD) throw new HookServiceError('EXECUTION_OUTPUT_LIMIT')
            this.consume(decoder.decode(next.value, { stream: true }), streaming)
            current.enqueue(next.value)
          }
        } catch (error) { fail(error instanceof HookServiceError ? error : new HookServiceError('MODEL_RESPONSE_INVALID')) }
      },
      cancel: () => { finished = true; this.failure = new HookServiceError('EXECUTION_CANCELLED'); this.pending = ''; this.data = []; this.blocks.clear(); this.text = ''; stop() },
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  private consume(value: string, streaming: boolean): void {
    this.pending += value
    if (!streaming) return
    let newline: number
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, '')
      this.pending = this.pending.slice(newline + 1)
      this.line(line)
    }
  }
  private line(value: string): void {
    if (!value) this.flush()
    else if (value.startsWith('data:')) this.data.push(value.slice(5).replace(/^ /, ''))
  }
  private flush(): void {
    if (!this.data.length) return
    const text = this.data.join('\n'); this.data = []
    if (text !== '[DONE]') this.json(JSON.parse(text))
  }
  private block(key: string, name?: unknown, raw?: unknown): void {
    if (this.blocks.size >= MAX_BLOCKS && !this.blocks.has(key)) invalid()
    const block = this.blocks.get(key) ?? { name: '', raw: '' }
    if (name !== undefined) { if (typeof name !== 'string') invalid(); if (block.name && block.name !== name) invalid(); block.name = name }
    if (raw !== undefined) { if (typeof raw !== 'string') invalid(); block.raw += raw }
    if (Buffer.byteLength(block.raw) > this.limit) throw new HookServiceError('EXECUTION_OUTPUT_LIMIT')
    this.blocks.set(key, block)
  }
  private addText(value: unknown): void {
    if (value === undefined || value === null) return
    if (typeof value !== 'string') invalid()
    this.text += value
    if (Buffer.byteLength(this.text) > this.limit) throw new HookServiceError('EXECUTION_OUTPUT_LIMIT')
  }
  private json(value: unknown): void {
    if (!record(value)) invalid()
    if (Array.isArray(value.choices)) {
      if (value.choices.length > 1) invalid()
      for (const choice of value.choices) {
        if (!record(choice) || choice.index !== undefined && choice.index !== 0) invalid()
        const delta = record(choice.delta) ? choice.delta : record(choice.message) ? choice.message : undefined
        if (!delta) continue
        this.addText(delta.content)
        if (Array.isArray(delta.tool_calls)) for (const [index, call] of delta.tool_calls.entries()) {
          if (!record(call) || !record(call.function)) invalid()
          this.block('chat:' + String(call.index ?? index), call.function.name, call.function.arguments)
        }
      }
    }
    if (value.type === 'content_block_start' && record(value.content_block)) {
      const block = value.content_block
      if (block.type === 'tool_use') this.block('anthropic:' + String(value.index), block.name)
      else if (block.type === 'text') this.addText(block.text)
    }
    if (value.type === 'content_block_delta' && record(value.delta)) {
      if (value.delta.type === 'input_json_delta') this.block('anthropic:' + String(value.index), undefined, value.delta.partial_json)
      else if (value.delta.type === 'text_delta') this.addText(value.delta.text)
    }
    if (value.type === 'response.output_item.added' && record(value.item) && value.item.type === 'function_call') this.block('responses:' + String(value.output_index), value.item.name, value.item.arguments)
    if (value.type === 'response.function_call_arguments.delta') this.block('responses:' + String(value.output_index), undefined, value.delta)
    if (value.type === 'response.output_text.delta') this.addText(value.delta)
  }
}

export function boundedModelResponse(response: Response, signal: AbortSignal, limit = EXECUTION_LIMITS.outputBytes): Response {
  if (!response.body || !Number.isSafeInteger(limit) || limit < 1) throw new HookServiceError('MODEL_RESPONSE_INVALID')
  const reader = response.body.getReader()
  let bytes = 0, finished = false
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stop = () => { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}) }
  const abort = () => { if (finished) return; finished = true; stop(); controller.error(new HookServiceError('EXECUTION_CANCELLED')) }
  const stream = new ReadableStream<Uint8Array>({
    start(current) { controller = current },
    pull: async current => {
      if (finished) return
      try {
        if (signal.aborted) return abort()
        const next = await reader.read()
        if (finished) return
        if (next.done) { finished = true; stop(); current.close(); return }
        bytes += next.value.byteLength
        if (bytes > limit) throw new HookServiceError('EXECUTION_OUTPUT_LIMIT')
        current.enqueue(next.value)
      } catch (error) { if (!finished) { finished = true; stop(); current.error(error instanceof HookServiceError ? error : new HookServiceError('MODEL_RESPONSE_INVALID')) } }
    },
    cancel: () => { finished = true; stop() },
  })
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
}
