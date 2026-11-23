# Split-key encryption spike (SIG-7)

Throwaway code that answers the questions in SIG-7: can a browser encrypt and
decrypt multi-gigabyte files in chunks under a key split between the link
fragment and the server, and how does it save the result to disk in each
browser. Nothing here ships. The findings and the recommended format go into
the issue, and production code gets written fresh in `packages/` or `apps/web`.

The key split:

- `F`, the fragment half (32 bytes), travels in the link after `#`.
- `S`, the server half (32 bytes), is generated in the sender's browser, held
  by the server, and released only after the receipt is signed.
- `metaKey = HKDF-SHA256(F, salt = transferId, info "sigill/v2/meta")`
- `contentKey = HKDF-SHA256(F ‖ S, salt = transferId, info "sigill/v2/content")`

## Tests

```sh
pnpm --filter @sigill/spike-split-key test
```

`pnpm check` at the root lints, typechecks and tests this package too.
