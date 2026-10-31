# Terminal font

JetBrains Mono 2.304, the web fonts of the official release
(`JetBrainsMono-2.304.zip` from
https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304, folder
`fonts/webfonts/`), licensed under the SIL Open Font License 1.1
(`OFL.txt`). The files are unmodified; each matches the blob of the same
path in the `v2.304` tag of the JetBrains Mono repository.

| File | SHA-256 |
| --- | --- |
| JetBrainsMono-Regular.woff2 | `a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2` |
| JetBrainsMono-Italic.woff2 | `cb6a1b246318ed3885d7dffa14a2609297fe80e9b8e500bea33b52fa312a36a4` |
| JetBrainsMono-Medium.woff2 | `086c48dfbea9ddaff1320f7e09399b8e2924e88ce67453721255db3bdbb5a353` |
| JetBrainsMono-MediumItalic.woff2 | `1c9b7a62ee6c3f77c82982a3d0ab7ead8805f5e67ccfc1942037fc65f398f22b` |
| JetBrainsMono-Bold.woff2 | `c503cc5ec5f8b2c7666b7ecda1adf44bd45f2e6579b2eba0fc292150416588a2` |
| JetBrainsMono-BoldItalic.woff2 | `3a013466c0eee979fb9d42c2d7a8887cd3645dc8b897cfc5b71781cf982efc5a` |

`../fonts.ts` registers them; `web/vite.config.ts` adds `OFL.txt` to the
generated `licenses.md`. To upgrade, replace the files from a newer release,
update this table and the version in both places.
