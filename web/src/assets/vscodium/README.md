# VSCodium logo

`codium.svg` is VSCodium's logo (`icons/stable/codium_cnl.svg` of
https://github.com/VSCodium/vscodium at commit `ca7f7b44b5e5`, SHA-256
`9817036bd2f5add672e707da311a301033ad122d6c2c505c776cb48d35b94472`),
designed by Jared Reich, under the MIT license of that repository
(`LICENSE`, copied unchanged). The repository has no other license or
trademark terms for its icons.

Changed here: the gradient fill is replaced by `currentColor` and the
XML prolog, `defs` and layer group are dropped, so the logo takes the
color of the buttons and tabs it marks as "VS Code"; the path is
unchanged. `../../components/icons.tsx` draws it; `web/vite.config.ts` adds
`LICENSE` to the generated `licenses.md`.
