# Third-party notices

## QuantPilot

WolfBot contains a material adaptation of the PI Agent loop and
OpenAI-compatible provider boundary from [QuantPilot](https://github.com/tiammomo/QuantPilot)
at commit [`2015ecdc8f3d891f81ff0a5a8d42a2d2f2dd0a5c`](https://github.com/tiammomo/QuantPilot/commit/2015ecdc8f3d891f81ff0a5a8d42a2d2f2dd0a5c).
The adapted source scope is:

- `wolf-dashboard/agent-sidecar/src/run-engine.ts`: the PI loop lifecycle,
  budget/termination contract, and provider-to-agent adaptation.
- `wolf-dashboard/agent-sidecar/src/provider.ts`: the OpenAI-compatible
  provider boundary and streaming message adaptation.

The sidecar-local notice at
`wolf-dashboard/agent-sidecar/THIRD_PARTY_NOTICE.md` records the same scope.
WolfBot-specific HTTP server code, five-tool allowlist, FastAPI integration,
schemas, skill governance, frontend, tests, and market code are not claimed as
copied QuantPilot source. Generated `dist/` files are build output and are not
part of the source attribution scope.

The referenced QuantPilot material is used under the MIT License. The complete
upstream license is available at the [LICENSE file for this commit](https://raw.githubusercontent.com/tiammomo/QuantPilot/2015ecdc8f3d891f81ff0a5a8d42a2d2f2dd0a5c/LICENSE)
and is reproduced below.

```text
MIT License

Copyright (c) 2025 Opactor AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The remaining runtime dependencies are third-party packages managed by
`wolf-dashboard/agent-sidecar/package-lock.json`; their package metadata and
license fields remain in the lockfile and are not replaced by this notice.
