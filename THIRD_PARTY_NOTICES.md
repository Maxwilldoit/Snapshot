# Third-party notices

## DSH Pet animation behavior configuration

The DSH action names, pools, categories, weights, movement parameters and reference
width in `src/lib/petBehavior.ts`, and the corresponding animation names in
`src/lib/petBehavior.test.ts`, are adapted from **DSH Pet** by **PC2005-cloud**.

- Project: https://github.com/PC2005-cloud/dsh-pet
- Pinned revision: `3229ab287d82d7621af2ee51544a0e746c2e40fd`
- Animation configuration: https://github.com/PC2005-cloud/dsh-pet/blob/3229ab287d82d7621af2ee51544a0e746c2e40fd/dsh-pet/assets/config.jsonc
- Reference width: https://github.com/PC2005-cloud/dsh-pet/blob/3229ab287d82d7621af2ee51544a0e746c2e40fd/dsh-pet/src/shared/constants.ts
- Picker semantics: https://github.com/PC2005-cloud/dsh-pet/blob/3229ab287d82d7621af2ee51544a0e746c2e40fd/dsh-pet/src/shared/pickers.ts
- Original license: https://github.com/PC2005-cloud/dsh-pet/blob/3229ab287d82d7621af2ee51544a0e746c2e40fd/dsh-pet/LICENSE

Snapshot resolves these names to existing imported WebM entries, omits missing
animations, converts movement timing to milliseconds, and maps work-status clips
to Snapshot events and persistent states. No animation media is bundled by this
module. The upstream copyright and permission notice is reproduced below.
The same license is included in release assets as `public/licenses/dsh-pet.txt`.

```text
MIT License

Copyright (c) 2026 PC2005-cloud

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
