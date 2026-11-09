import type { AttributedAction, DispatchOrigin, DispatchResult } from './engine.js'
import type { HookAction, PermissionDecision } from './effect-types.js'

type Kind = HookAction['kind']
type ActionOf<K extends Kind> = AttributedAction<Extract<HookAction, { kind: K }>>
export interface SuppressedEffect {
  readonly code: 'REWRITE_SUPERSEDED' | 'REWRITE_BLOCKED' | 'CONTINUATION_STOPPED'
  readonly origin: DispatchOrigin
}
export interface EffectResolution {
  readonly control: 'default' | 'cancelled' | 'stop' | 'block' | PermissionDecision
  readonly proceed: boolean
  readonly cancelled: boolean
  readonly permission?: ActionOf<'permission'>
  readonly input?: ActionOf<'replace-input'>
  readonly stop?: ActionOf<'stop-session'>
  readonly block?: ActionOf<'block-event'>
  readonly continuations: readonly ActionOf<'continue-turn'>[]
  readonly context: readonly ActionOf<'context'>[]
  readonly feedback: readonly ActionOf<'feedback'>[]
  readonly warnings: readonly ActionOf<'warning'>[]
  readonly extensions: readonly ActionOf<'native-extension'>[]
  readonly resultReplacements: readonly ActionOf<'replace-result'>[]
  readonly suppressed: readonly SuppressedEffect[]
  readonly unresolved: readonly { readonly code: 'RESULT_CONFLICT_UNVERIFIED'; readonly origins: readonly DispatchOrigin[] }[]
}

function ofKind<K extends Kind>(actions: readonly AttributedAction[], kind: K): readonly ActionOf<K>[] {
  return Object.freeze(actions.filter(row => row.action.kind === kind) as ActionOf<K>[])
}

function origin({ action: _action, ...value }: AttributedAction): DispatchOrigin {
  return Object.freeze(value)
}

function byCompletion(left: DispatchOrigin, right: DispatchOrigin): number {
  return left.completionOrder - right.completionOrder || left.configuredOrder - right.configuredOrder
}

function stopContinuations(actions: readonly AttributedAction[]): readonly ActionOf<'continue-turn'>[] {
  const continuations = ofKind(actions, 'continue-turn')
  const claude = continuations.filter(row => row.dialect === 'claude-code').sort(byCompletion)
  let index = 0
  return Object.freeze(continuations.map(row => row.dialect === 'claude-code' ? claude[index++]! : row))
}

export function resolveEffects(dispatch: DispatchResult): EffectResolution {
  const actions = dispatch.cancelled ? [] : dispatch.actions
  const permission = dispatch.cancelled ? undefined : dispatch.permission
  const stops = ofKind(actions, 'stop-session')
  let stop = stops[0]
  if (dispatch.diagnostic.event === 'Stop' && stop?.dialect === 'claude-code') {
    for (const candidate of stops) if (candidate.dialect === 'claude-code' && byCompletion(candidate, stop) > 0) stop = candidate
  }
  const block = ofKind(actions, 'block-event')[0]
  const control: EffectResolution['control'] = dispatch.cancelled ? 'cancelled' : stop ? 'stop' : block ? 'block' : permission?.action.decision ?? 'default'
  const proceed = control === 'default' || control === 'allow'
  const canRewrite = proceed || control === 'ask'
  const rewrites = ofKind(actions, 'replace-input')
  let input: EffectResolution['input']
  if (canRewrite) {
    for (const row of rewrites) {
      if (!input || row.completionOrder > input.completionOrder || (row.completionOrder === input.completionOrder && row.configuredOrder > input.configuredOrder)) input = row
    }
  }
  const suppressed: SuppressedEffect[] = []
  for (const row of actions) {
    if (row.action.kind === 'continue-turn' && stop) suppressed.push(Object.freeze({ code: 'CONTINUATION_STOPPED', origin: origin(row) }))
    if (row.action.kind === 'replace-input' && row !== input) suppressed.push(Object.freeze({ code: canRewrite ? 'REWRITE_SUPERSEDED' : 'REWRITE_BLOCKED', origin: origin(row) }))
  }
  const resultReplacements = ofKind(actions, 'replace-result')
  const unresolved: EffectResolution['unresolved'] = resultReplacements.length > 1 ? Object.freeze([Object.freeze({ code: 'RESULT_CONFLICT_UNVERIFIED', origins: Object.freeze(resultReplacements.map(origin)) })]) : Object.freeze([])
  return Object.freeze({
    control, proceed, cancelled: dispatch.cancelled, ...(permission ? { permission } : {}), ...(input ? { input } : {}), ...(stop ? { stop } : {}), ...(block ? { block } : {}),
    continuations: stop ? Object.freeze([]) : dispatch.diagnostic.event === 'Stop' ? stopContinuations(actions) : ofKind(actions, 'continue-turn'), context: ofKind(actions, 'context'),
    feedback: ofKind(actions, 'feedback'), warnings: ofKind(actions, 'warning'), extensions: ofKind(actions, 'native-extension'),
    resultReplacements, suppressed: Object.freeze(suppressed), unresolved,
  })
}
