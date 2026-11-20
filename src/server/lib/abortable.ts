/** The error an operation ends with when its signal aborts: the shape Node's own abortable calls use, and no text about what was being done. */
export function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}
