import type { Dialect } from './contracts.js'
import type { NativeEvent } from './types.js'

export function eventForDialect(event: NativeEvent, dialect: Dialect): NativeEvent {
  const name = event.dialectEvents?.[dialect]
  return name === undefined || name === event.event ? event : { ...event, event: name }
}
