/** Polls `check` until it holds; throws after `timeoutMs`. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(10)
  }
}
