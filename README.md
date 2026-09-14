# agnivesh.in

Personal site and blog, built with [Hugo](https://gohugo.io). Every push to `master` builds and deploys it to GitHub Pages (`.github/workflows/hugo.yaml`).

## Run it locally

```bash
hugo server
```

Then open http://localhost:1313. Needs Hugo 0.146 or newer; CI uses 0.153.2.

## Where things live

| What | File |
| --- | --- |
| Name, role, bio, email, social links, menu | `hugo.yaml` |
| Home page intro | `content/_index.md` |
| Projects and community entries (featured ones also show on the home page) | `content/projects.md` |
| About page | `content/about.md` |
| Posts | `content/posts/` |
| Portrait (home page, bylines, link previews) | `assets/avatar.png` |
| All styling: colors, fonts, spacing, light and dark | `assets/css/main.css` |
| Theme toggle, code Copy buttons, "On this page" highlight | `assets/js/site.js` |
| Page templates | `layouts/` |
| Fonts (IBM Plex Sans and Mono, SIL Open Font License) | `static/fonts/` |

## Writing a post

```bash
hugo new content posts/my-post.md --kind post
```

Fill in `description` in the front matter. It shows under the title, in the post lists, and in link previews on LinkedIn and X. Without it, the first lines of the post are used.

Posts with three or more `##`/`###` headings get an "On this page" list automatically. Add `toc: false` to a post's front matter to turn it off.

Light and dark mode follow the reader's system setting; the button in the header switches between them and remembers the choice.
