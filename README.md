# Overleaf Workshop

[![GitHub Repo stars](https://img.shields.io/github/stars/overleaf-workshop/Overleaf-Workshop)](https://github.com/overleaf-workshop/Overleaf-Workshop)
[![version](https://img.shields.io/visual-studio-marketplace/v/iamhyc.overleaf-workshop)](https://marketplace.visualstudio.com/items?itemName=iamhyc.overleaf-workshop)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/iamhyc.overleaf-workshop)](https://marketplace.visualstudio.com/items?itemName=iamhyc.overleaf-workshop)
[![updated](https://img.shields.io/visual-studio-marketplace/last-updated/iamhyc.overleaf-workshop)](https://marketplace.visualstudio.com/items?itemName=iamhyc.overleaf-workshop)
[![release](https://img.shields.io/visual-studio-marketplace/release-date/iamhyc.overleaf-workshop)](https://vsmarketplacebadge.apphb.com/downloads-short/iamhyc.overleaf-workshop.svg)

Open Overleaf (ShareLatex) projects in VSCode, with full collaboration support.

### User Guide

The full user guide is available at [GitHub Wiki](https://github.com/overleaf-workshop/Overleaf-Workshop/wiki).

### Features

> [!NOTE]
> For SSO login or captcha enabled servers like `https://www.overleaf.com`, please use "**Login with Cookies**" method.
> For more details, please refer to [How to Login with Cookies](#how-to-login-with-cookies).

- Login Server, Open Projects and Edit Files

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo01-login.gif" height=400px/>

- On-the-fly Compiling and Previewing
  > <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> to compile, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> preview.

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo03-synctex.gif" height=400px/>

- SyncTeX and Reverse SyncTeX
  > <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> to jump to PDF.
  > Double click on PDF to jump to source code

- Chat with Collaborators

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo06-chat.gif" height=400px/>

- Open Project Locally, Compile/Preview with [LaTeX-Workshop](https://github.com/James-Yu/LaTeX-Workshop)

    <img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/demo07-local.gif" height=400px/>

### How to Login with Cookies

<img src="https://raw.githubusercontent.com/overleaf-workshop/Overleaf-Workshop/master/docs/assets/login_with_cookie.png" height=400px/>

In an already logged-in browser (Firefox for example):

1. Open "Developer Tools" (usually by pressing <kbd>F12</kbd>) and switch to the "Network" tab;

   Then, navigate to the Overleaf main page (e.g., `https://www.overleaf.com`) in the address bar.

2. Filter the listed items with `/project` and select the exact match.

3. Check the "Cookie" under "Request Headers" of the selected item and copy its value to login.
    > The format of the Cookie value would be like: `overleaf_session2=...` or `sharelatex.sid=...`

### Compatibility

The following Overleaf (ShareLatex) Community Edition docker images provided on [Docker Hub](https://hub.docker.com/r/sharelatex/sharelatex) have been tested and verified to be compatible with this extension.

- [x] [sharelatex/sharelatex:5.0.4](https://hub.docker.com/layers/sharelatex/sharelatex/5.0.4/images/sha256-429f6c4c02d5028172499aea347269220fb3505cbba2680f5c981057ffa59316?context=explore) (verified by [@Mingbo-Lee](https://github.com/Mingbo-Lee))

- [x] [sharelatex/sharelatex:4.2.4](https://hub.docker.com/layers/sharelatex/sharelatex/4.2.4/images/sha256-ac0fc6dbda5e82b9c979721773aa120ad3c4a63469b791b16c3711e0b937528c?context=explore)

- [x] [sharelatex/sharelatex:4.1](https://hub.docker.com/layers/sharelatex/sharelatex/4.1/images/sha256-3798913f1ada2da8b897f6b021972db7874982b23bef162019a9ac57471bcee8?context=explore) (verified by [@iamhyc](https://github.com/iamhyc))

- [x] [sharelatex/sharelatex:3.5](https://hub.docker.com/layers/sharelatex/sharelatex/3.5/images/sha256-f97fa20e45cdbc688dc051cc4b0e0f4f91ae49fd12bded047d236ca389ad80ac?context=explore) (verified by [@iamhyc](https://github.com/iamhyc))

- [ ] [sharelatex/sharelatex:3.4](https://hub.docker.com/layers/sharelatex/sharelatex/3.4/images/sha256-2a72e9b6343ed66f37ded4e6da8df81ed66e8af77e553b91bd19307f98badc7a?context=explore)

- [ ] [sharelatex/sharelatex:3.3](https://hub.docker.com/layers/sharelatex/sharelatex/3.3/images/sha256-e1ec01563d259bbf290de4eb90dce201147c0aae5a07738c8c2e538f6d39d3a8?context=explore)

- [ ] [sharelatex/sharelatex:3.2](https://hub.docker.com/layers/sharelatex/sharelatex/3.2/images/sha256-5db71af296f7c16910f8e8939e3841dad8c9ac48ea0a807ad47ca690087f44bf?context=explore)

- [ ] [sharelatex/sharelatex:3.1](https://hub.docker.com/layers/sharelatex/sharelatex/3.1/images/sha256-5b9de1e65257cea4682c1654af06408af7f9c0e2122952d6791cdda45705e84e?context=explore)

- [ ] [sharelatex/sharelatex:3.0](https://hub.docker.com/layers/sharelatex/sharelatex/3.0/images/sha256-a36e54c66ef62fdee736ce2229289aa261b44f083a9fd553cf8264500612db27?context=explore)

### Development

Please refer to the development guidance in [CONTRIBUTING.md](./CONTRIBUTING.md)

### References

- [Overleaf Official Logos](https://www.overleaf.com/for/partners/logos)
- [Overleaf Web Route List](./docs/webapi.md)
- [James-Yu/LaTeX-Workshop](https://github.com/James-Yu/LaTeX-Workshop)
- [jlelong/vscode-latex-basics](https://github.com/jlelong/vscode-latex-basics/tags)
