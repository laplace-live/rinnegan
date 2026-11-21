/** Page assets are imported `with { type: 'text' }`, which inlines them into the bundle as strings. */
declare module '*.css' {
  const text: string
  export default text
}
