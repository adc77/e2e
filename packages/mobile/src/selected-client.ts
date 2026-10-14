/**
 * An agent-device client whose device commands name the worker's device. The
 * daemon resolves a command against its session's device only while the
 * session is bound to one: before the first open, after `closeApp` ends the
 * session, and in a worker that replaced a failed one, a command that names
 * no device is resolved among every booted device of the machine, and fails
 * once two match. The selection is put on here once instead of at each call
 * site, so no new device command can forget it.
 */

import type { AgentDeviceClient } from './options.ts';
import type { DeviceSelection } from './pool.ts';

/**
 * The namespaces that act on the device itself, with or without a session:
 * launching, closing, and installing apps, booting, device settings, and the
 * screen recorder. `capture`, `interactions`, and `command` act on the app the
 * session has open and take no selection: with one, a session `closeApp`
 * ended would read or tap whatever the device shows instead of failing as
 * APP_NOT_OPEN, and on Android `appstate` would answer with the launcher.
 */
const SELECTED: ReadonlySet<PropertyKey> = new Set(['apps', 'devices', 'recording', 'settings']);

/** Whether a command's first argument is an options object the selection can join. */
function isOptions(value: unknown): value is Record<string, unknown> | undefined {
  return value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value));
}

/**
 * Wraps `client` so every device command's options carry `selection`. A first
 * argument that is not an options object is passed through untouched.
 */
export function selectedClient(client: AgentDeviceClient, selection: DeviceSelection): AgentDeviceClient {
  const namespaces = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, property, receiver) {
      const namespace: unknown = Reflect.get(target, property, receiver);
      if (!SELECTED.has(property) || namespace === null || (typeof namespace !== 'object' && typeof namespace !== 'function')) return namespace;
      let selected = namespaces.get(property);
      if (selected === undefined) {
        selected = selectedNamespace(namespace, selection);
        namespaces.set(property, selected);
      }
      return selected;
    },
  });
}

/** One client namespace whose methods merge the selection into their options. */
function selectedNamespace(namespace: object, selection: DeviceSelection): unknown {
  return new Proxy(namespace, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== 'function') return method;
      return (options?: unknown, ...rest: unknown[]): unknown =>
        Reflect.apply(method, target, [isOptions(options) ? { ...selection, ...options } : options, ...rest]);
    },
  });
}
