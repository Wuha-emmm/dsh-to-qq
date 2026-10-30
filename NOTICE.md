# NOTICE

DSH-to-QQ incorporates design ideas and (optionally) animation assets from the
**dsh-pet** project.

## Referenced work

- Project: **dsh-pet** — https://github.com/PC2005-cloud/dsh-pet
- Author: PC2005-cloud

## What we reuse

- Interaction patterns: a draggable floating companion, click reactions, and an
  expandable panel anchored to the companion.
- **Optional animation clips** (transparent VP9/webm). If a clip ships in
  `client/assets/`, it comes from dsh-pet and is covered by the terms below.

## Terms we honour

- dsh-pet **code** is MIT. Our code remains MIT (see `LICENSE`).
- dsh-pet **assets** (animations, prompts, source videos) may be used in open
  source, but **commercial use is forbidden**. This repository is a personal,
  non-commercial project.
- Derivative works must credit the original author on public channels
  (GitHub repository, product site): https://github.com/PC2005-cloud/dsh-pet
- The character 「大肥鱼」/ 「鲸鱼娘」 is community fan art, **not** an official
  DeepSeek character:
  - original character 「溟月」 by Bilibili @上善无形
  - DeepSeek maid version designed by Bilibili @ZipZipPipe
- Character licence: **CC BY-NC-SA 4.0** (Attribution · NonCommercial ·
  ShareAlike) — https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans
  Quoted from the author: 「大肥鱼是遵守CC BY-NC-SA 4.0协议的形象，不可以以任何形式
  商业化。」

## Consequence for this project

The animation assets are **not** MIT. They are distributed under the terms
above and must be removed if this project is ever commercialised. Code and assets
are therefore licensed separately:

| Part | Licence |
|---|---|
| `src/`, `client/`, `docs/`, tests | MIT |
| `client/assets/*.webm` (when present) | dsh-pet asset terms (non-commercial, attribution) |
| Character imagery | CC BY-NC-SA 4.0 |
