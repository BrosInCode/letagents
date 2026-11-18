// Downloading a room message attachment without trusting where the room sends
// you: the room API answers with a redirect to presigned object storage, and
// that address is fetched with no credential and no further redirect. Used by
// the desktop daemon and by the MCP server (npm package and remote endpoint).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** The statuses a room's attachment route answers with: a redirect to storage. */
export const ATTACHMENT_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A download that did not give usable bytes. Its message never holds an address or a credential. */
export class AttachmentDownloadError extends Error {
  constructor(reason) {
    super(reason === 'too_large' ? 'The attachment is larger than the limit.' : 'The attachment could not be downloaded.');
    this.reason = reason;
    // The name the daemon has always used for it.
    this.name = 'RoomAttachmentDownloadError';
  }
}

/**
 * Read at most `maxBytes` of a response body. The declared length is a hint;
 * the counted bytes decide.
 */
export async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new AttachmentDownloadError('too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AttachmentDownloadError('too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * An address on this machine or only on its link: loopback, unspecified or
 * link-local (cloud metadata lives there). Private networks are not in it,
 * because self-hosted object storage may live on one.
 */
export function isThisMachineAddress(address) {
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase();
  // An IPv4-mapped address, in either the dotted form or the hex form a URL normalizes it to.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  const v4 = hex ? [parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255, parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join('.')
    : bare.startsWith('::ffff:') && isIP(bare.slice(7)) === 4 ? bare.slice(7) : bare;
  if (isIP(v4) === 4) {
    const [first, second] = v4.split('.').map(Number);
    return first === 127 || first === 0 || (first === 169 && second === 254);
  }
  return isIP(bare) === 6 && (bare === '::1' || bare === '::' || /^fe[89ab]/.test(bare));
}

export function namesThisMachine(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare.endsWith('.localhost') || isThisMachineAddress(bare);
}

/** A room API in development runs on loopback itself; a link-local one is another device. */
export function isLoopbackApiUrl(apiUrl) {
  const bare = new URL(apiUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare.endsWith('.localhost') || bare === '::1' || (isIP(bare) === 4 && bare.startsWith('127.'));
}

/**
 * The storage address the room API redirected to: absolute and HTTPS. Only a
 * room API on this machine (development) may send the caller to this
 * machine, over HTTP too; a remote one may not point it at local services.
 */
export function attachmentStorageUrl(location, apiUrl) {
  let url;
  try { url = new URL(location ?? ''); } catch { throw new AttachmentDownloadError('unavailable'); }
  const localApi = isLoopbackApiUrl(apiUrl);
  if (url.username || url.password || (namesThisMachine(url.hostname) && !localApi)
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && localApi && namesThisMachine(url.hostname)))) {
    throw new AttachmentDownloadError('unavailable');
  }
  return url;
}

/**
 * Whether a storage host name resolves to this machine. Checked before the
 * request for a remote room API; a name that does not resolve is refused too.
 * A resolver that answers differently a moment later is not covered.
 */
export async function storageResolvesToThisMachine(hostname, signal,
  resolve = (name) => lookup(name, { all: true, verbatim: true })) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return isThisMachineAddress(bare);
  signal.throwIfAborted();
  // The system resolver cannot be cancelled, so Stop and the deadline stop the wait for it.
  let detach = () => {};
  const aborted = new Promise((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    detach = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    const addresses = await Promise.race([resolve(bare), aborted]);
    return !addresses.length || addresses.some(({ address }) => isThisMachineAddress(address));
  } catch (error) {
    if (signal.aborted) throw error;
    return true;
  } finally { detach(); }
}
