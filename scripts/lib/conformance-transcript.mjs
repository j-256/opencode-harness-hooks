import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { readNativeCodexThread } from './native-codex-inventory.mjs'

const MAX_BYTES = 2 * 1024 * 1024
export function inspectCodexTranscript(records, input, prompt) {
  try {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
    if (!Array.isArray(records) || !uuid.test(input.session_id) || !uuid.test(input.turn_id)) return false
    const metadata = records.filter(row => row?.type === 'session_meta')
    if (metadata.length !== 1 || metadata[0].payload?.id !== input.session_id || metadata[0].payload?.session_id !== input.session_id) return false
    const items = records.filter(row => row?.type === 'response_item').map(row => row.payload)
    if (!items.some(item => item?.type === 'message' && item.role === 'user' && Array.isArray(item.content) && item.content.some(part => part?.type === 'input_text' && part.text === prompt))) return false
    const calls = items.filter(item => item?.type === 'function_call' && item.call_id === input.tool_use_id)
    if (calls.length !== 1 || calls[0].name !== 'exec_command' || calls[0].internal_chat_message_metadata_passthrough?.turn_id !== input.turn_id) return false
    if (JSON.parse(calls[0].arguments).cmd !== input.tool_input.command) return false
    return !items.some(item => item?.type === 'function_call_output' && item.call_id === input.tool_use_id)
  } catch { return false }
}

export async function verifyCodexTranscriptReader({ binary, root, project, input, prompt, fixtureID, nativeHome }) {
  try {
    if (!isAbsolute(input.transcript_path) || (await stat(input.transcript_path)).size > MAX_BYTES) return false
    const before = await readFile(input.transcript_path)
    if (before.length > MAX_BYTES) return false
    const metadata = JSON.parse(before.toString('utf8').split('\n')[0]).payload
    if (!/^\d{4}-\d{2}-\d{2}T/.test(metadata.timestamp)) return false
    const home = nativeHome ?? join(root, 'readers', fixtureID)
    if (!nativeHome) {
      const path = join(home, 'sessions', ...metadata.timestamp.slice(0, 10).split('-'), basename(input.transcript_path))
      await mkdir(dirname(path), { recursive: true })
      await symlink(input.transcript_path, path)
      await writeFile(join(home, 'config.toml'), '[features]\nhooks=true\n')
    }
    const result = await readNativeCodexThread(binary, project, { PATH: process.env.PATH, HOME: nativeHome ? dirname(nativeHome) : home, CODEX_HOME: home, TMPDIR: home, LANG: 'C', SHELL: '/bin/sh' }, input.session_id)
    const turn = result.thread?.turns.find(turn => turn.id === input.turn_id)
    return result.thread.id === input.session_id && turn?.items.some(item => item.type === 'userMessage' && item.content.some(part => part.type === 'text' && part.text === prompt)) === true && before.equals(await readFile(input.transcript_path))
  } catch { return false }
}
