import assert from 'node:assert/strict'
import { test } from 'node:test'

const library = () => import(new URL('../scripts/lib/permission-denial.mjs', import.meta.url).href)
const prefix = 'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules '
const deny = { permission: 'bash', pattern: 'printf*', action: 'deny' }

test('configured denial requires the pinned host signature and the actual denied command rule', async () => {
  const { isConfiguredCommandDenial } = await library()
  assert.equal(isConfiguredCommandDenial(prefix + JSON.stringify([{ permission: '*', action: 'allow', pattern: '*' }, deny])), true)
  for (const changed of [{ ...deny, permission: 'write' }, { ...deny, action: 'ask' }, { ...deny, pattern: 'different*' }]) assert.equal(isConfiguredCommandDenial(prefix + JSON.stringify([changed])), false)
})

test('rule-processing errors and malformed rule descriptions cannot certify a configured denial', async () => {
  const { isConfiguredCommandDenial } = await library()
  for (const content of ['Permission rule evaluation failed', 'Error processing rule ' + JSON.stringify(deny), prefix + 'invalid rules', prefix + '{}', prefix + '[]', prefix + JSON.stringify([null]), prefix + JSON.stringify([deny]) + ' unrelated failure', undefined]) assert.equal(isConfiguredCommandDenial(content), false)
})
