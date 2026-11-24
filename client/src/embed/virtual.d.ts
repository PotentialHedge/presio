declare module "virtual:presio-builtin-plugins" {
  /** Each built-in plugin: its folder name, raw manifest and self-contained HTML. */
  const plugins: { name: string; manifest: unknown; html: string }[];
  export default plugins;
}
