# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.15.6] - 2025-10-30
### Changed
- chore(deps): bump brace-expansion in /views/chat-view
  - Commit: b780bb3401661d0a8ee3e62a64114f42b863cb5a
- chore(deps): bump form-data from 4.0.0 to 4.0.4
  - Commit: 23d0873004f3e08c6836d72bfd6fab0016f2574a
- chore(deps-dev): bump vite from 6.3.5 to 6.3.6 in /views/chat-view
  - Commit: 30e83b17cce3ebb78f79412a37b0fb9f0dc03c1c
- chore(deps-dev): bump vite from 6.3.6 to 6.4.1 in /views/chat-view
  - Commit: 2053c025373545c96d98277f8c61c4e54c9c376e

### Fixed
- fix: file rename
  - Commit: 1018f4ba03238a6863b1ff2d863743731b9770b8
- fix: mark isViewerEmbedded as true for pdfviewer to avoid unnecessary focus
  - Commit: 15f19f2433fe841f6312270554d7b5b328155f19

## [0.15.5] - 2025-07-08
### Changed
- feat: enable code spell checker by default
  - Commit: c0c5cba2dce779ea52c07f372775fd49ae9d3814
- feat: check if already exists a texteditor with document shown, show it directly
  - Commit: 926e60e558b5d878fd919a8ee3f3b8adf64deeab
- chore: unified-latex version to 1.8.3
  - Commit: 8610632554a4a403269b90720c688ca4355b8470
- chore(deps-dev): bump vite from 6.2.6 to 6.3.5 in /views/chat-view
  - Commit: 487db3077018395a92807cfddaac55ee30fff87a
- Potential fix for code scanning alert no. 2: Workflow does not contain permissions
  - Commit: 0c68501620699bd333bfd8917dfc7f8a8c4fd0cf
- Potential fix for code scanning alert no. 3: Workflow does not contain permissions
  - Commit: fd5ba0dec9c5d743bab0d11f0f91f616a980fa1c
- chore(deps-dev): upgrade brace-expansion dependency
  - Commit: 464c78e893a7c0525454aa0e10c49faf0c996fd7

### Fixed
- fix: update content when ready, fix cannot drag to new window (#270)
  - Commit: f3fc02260ae06f7af2cf517574d98fe721027289
- fix(remoteFileSystemProvider): robust project name parsing for special characters (#284)
  - Commit: 14f30f4dc2dd096aa4071b432c59ddacaf733902

## [0.15.4] - 2025-04-16
### Changed
- fix: overleaf synccode
  - Commit: 4fcfb68df19b570b11aef1697be9ac4f610c8f28

## [0.15.3] - 2025-04-15
### Changed
- fix: overleaf official site connection loss
  - Commit: 264f3c741ebe790d3b399039a1b6f00ecac1ed88

## [0.15.2] - 2025-04-11
### Changed
- fix: document link provider completed with common postfix
  - Commit: 46c178b404738d060004d803ccfe557be069b70b
- fix: syncpdf compatible with latest version
  - Commit: dc8efd5fa4be7168cf41242606c53cb9dfa3017f

## [0.15.1] - 2025-04-01
### Added
- feat: enable format without line break
  - Commit: 33dd4835919ac2f6434cc13975973ebc4d33fc29

### Changed
- chore(deps-dev): bump vite from 4.5.5 to 4.5.9 in /views/chat-view
  - Commit: 53fbfed4dbd7b8cb8a0ef9eef77286c286dfbe1e
- chore(deps): bump esbuild, @vitejs/plugin-vue and vite
  - Commit: e73ff61a242c4383830f8c5f6338db9420fb4e1f
- docs: update wiki about formatter setting on line break
  - Commit: 59a114bcb199da86d71f892a8c13089345449f59

## [0.15.0] - 2025-01-16
### Added
- feat(scm): allow to set local replica folder name
  - Commit: 9635545921d3fc50fddc35bd1147765a458ca521
- feat: enable compiling different root file when opened
  - Commit: 97501e03eae51c3926ac0b5d896c7aa0443b013c

## [0.14.0] - 2024-10-10
### Changed
- feat(pdfjs): remove pdfjs page border
  - Commit: 408aa79e0ff4906d33c977304081359f13e25f9a
- chore(scm): local replica update default ignore patterns
  - Commit: f3c12f09f088636b34e651ad2a4c59c28d1b1d20
- chore(deps): bump micromatch from 4.0.5 to 4.0.8
  - Commit: c0564b240cf07ae122a116e1c21d58ffbe8603a9
- chore(deps-dev): bump micromatch from 4.0.5 to 4.0.8 in /views/chat-view
  - Commit: 7191c3d74c86e453c094a222cd14430b7e51fe75
- chore(deps): bump rollup from 3.29.4 to 3.29.5 in /views/chat-view
  - Commit: 7290a11aeb36aa010da575116684e926d289ab85
- feat(intellisense): fuzzy filterText match
  - Commit: 731d075dfb82a768a34adc3ef65cf57ad24f21f5

### Fixed
- fix: missing chapter in outline (#195)
  - c1552cfe57ac0820b96eccfa7fc0e9340549e2a4

## [0.13.2] - 2024-08-12
### Changed
- chore(deps): bump vue-template-compiler and vue-tsc in /views/chat-view
  - Commit: 24217d0ed276e8e16c2a9cddcbf6189c1344f3c4
- feat: Better Compiling Experience (#171)
  - Commit: 69f5e8fdafdef444aa54bf37a32d25d99f22181b

## [0.13.1] - 2024-07-20
### Fixed
- fix: autocompletion completion for command beginwith or endwith cite
  - Commit: 0116b78f62646c00128b46ec102bbc9eb370026e

## [0.13.0] - 2024-06-30
### Changed
- chore(deps-dev): bump braces from 3.0.2 to 3.0.3
  - Commit: 80a229ccbae016a1c5ce033bc1efc21cca583897
- chore(deps-dev): bump braces from 3.0.2 to 3.0.3 in /views/chat-view
  - Commit: 7e9dc2bb2cd0d7636860a285270c9d6070d95801
- feat: local replica bulky sync with progress and cancelable (#155)
  - Commit: df2e8b17afc98d59c1dbd12d555ebb9bddf1817c

## [0.12.3] - 2024-05-28
### Fixed
- fix: save dirty files before compile
  - Commit: cb8f847ee51433e291fcedb9dd52d0e8d9acbe95
- fix: missing biblatex completion
  - Commit: 58e1c079637a277df3195bb834a151eae989bc1d

## [0.12.2] - 2024-05-20
### Changed
- chore: fix husky script execution
  - Commit: 9b76c26a69abf4987f9e61c25185d2529e2df8a8
### Fixed
- fix(intellisense): filter duplicate reference entries
  - Commit: ef87e99dee17114f289d08f3c99127168cebe0aa
- fix(scm): local replica better experience (#138)
  - Commit: 54d32f9927a0f13d6694547ae60b990ded1e0fe3

## [0.12.1] - 2024-04-28
### Fixed
- fix: automatically logout if cookie expired (#127)
  - Commit: 4646d4925846f9f6afdced7b315d789c80116e60

## [0.12.0] - 2024-04-05
### Added
- feat: enable folding for macro and environment
  - Commit: 6d97c7339d49c9d1a4b282843732f9c20940b0b1
- feat(core): allow to copy a project
  - Commit: 5c0ba4233636a9691d908f6ce6b31e32b4b6872e

### Changed
- chore(deps-dev): bump vite from 4.5.2 to 4.5.3 in /views/chat-view
  - Commit: 2e75c610dc16e2d645cf28034b4816e1f3623c6f

## [0.11.0] - 2024-03-05
### Added
- feat: icon for compile and view pdf
  - Commit: 6a859d2cff0e07c7de43d16f431d387f80a95ef2

### Fixed
- fix: Invisible Mode Unexpected Behavior (#113)
  - Commit: 16aaebe292c5e61ae3f33c29da2b614c01b598c6

## [0.10.0] - 2024-02-24
### Added
- feat(scm): support multi-file diff
  - Commit: 8e8dfd84506499450711fddc0b90e8cda391c79f

### Fixed
- fix(scm): history diff compare in reversed order
  - Commit: a012a06a71c4773f345889954957e13dfbedc6cd
- fix(scm): set settings with uri string
  - Commit: 41e91cbc5a829506c84f0c64fc9ea4f66fb5125e
- fix(scm): dispose all scm triggers when dispose
  - Commit: 999450fa0a72bf517da62a53fa6c7a325ebad354

## [0.9.1] - 2024-02-13
### Fixed
- fix(pdfView): restrict activate condition
  - Commit: 5a8ff9c55555fe1d0769d7a327af425b74e4a1a0

## [0.9.0] - 2024-01-29
### Added
- feat: create tex symbol caches
  - Commit: 26efc6dfa48eb88211c32aae2208728e371d64ec
- feat: make tex symbol provider store the project cache
  - Commit: 571833138488e5e8643fcc9ae9664bc91c1c2bdb
- feat: provide bib file to bibItem completion
  - Commit: a4d5dd3e97b7c89ebbdc127242ad7945eaccbd75

### Changed
- chore: Refactor and Cleanup Intellisense Implementation (#92)
  - Commit: d7a29b2027d25b3affa395b1cebc2691297f77ed

## [0.8.2] - 2024-01-26
### Changed
- chore: only use warning message for input required
  - Commit: a6f7db128e85cbe1c98873647ec196de8b0f9ecb

### Fixed
- fix(ci): remove task trigger on version tag
  - Commit: 703099f856117ffadec6ce84fa9905a6b84c7828
- fix(scm): Local Replica Unexpected Behavior (#89)
  - Commit: eedf8272012fef27381094608244dd0239d4e894

## [0.8.1] - 2024-01-17
### Added
- ci: auto publish on tag update
  - Commit: 0622fd11c416b1f01757c8af0d00a0978aa128d6

### Fixed
- fix: typo in keybindings for mac
  - Commit: c733cddff9b84f6201f2b8af475dc0c094b09158
- fix: use error/warning popup for user input
  - Commit: d7f6602abb1676a46eb03de3ffa63a4c678ba7e9

## [0.8.0] - 2024-01-12
### Added
- chore: Create config.yaml
  - Commit: 87f019ed8b17be356fe7f0d767169dabfe18b990
- feat(compiler): support compiler main document setting
  - Commit: 52af7966f57d18c8b3e274909996814b26bb4794

### Changed
- feat: allow to enable compile and preview in local folder
  - Commit: 32cfaf3fa1a7ede8421d564170acaf5cc09f385d

## [0.7.1] - 2024-01-05
### Added
- chore: update issue templates
  - Commit: fd4c48e60712a3c01da86fe7c50287afe5569dc0
- Create CODE_OF_CONDUCT.md
  - Commit: 3c17acc2e4c6b97df57ec65295fea2434a70cc95
- doc: add changelog
  - Commit: 02c2ea6e84f5e6a3ce828a2155a74f22ebea4b2f
- doc: add contribution guidance
  - Commit: 1c6b5191f25bd2abab2b3e0490dc32152e79c0cc
- chore: add commitlint with husky
  - Commit: 6d533a3c1ca9c094c8a68a0a9d6116e10a2131e1
- feat: integrate vscode l10n
  - Commit: 643456b2c67c4bdfcb67ecf6c2d37206a54142de
- feat(config): support machine-wide vscode configuration
  - Commit: 8e3580b34a575ec4a09336d04ae020f980b2b250
- build(workflows): add github action lock-threads
  - Commit: 000d3ba39ae8efa17b8da94db889f6ad367ef3da
- docs: add extension anatomy for developers
  - Commit: 20f2d1d428d02afa25e3d235791baf6d7a5402f5
- docs(anatomy): fix dependency graph inprecision
  - Commit: 773e935fb1c64ac36363a2909f1f5152ff1b802a
- docs(anatomy): add click jump for dependency graph
  - Commit: f5626d433c3e639d9b449cd3175400ee3d198ca1
- docs(wiki): update servers&projects management part
  - Commit: f3dc1553fb800c224a0f645fa44566283302f574
- docs(wiki): update the remaining part
  - Commit: 6a0610e7c2efb89f5a22fbadf82b09b84b168650
- build(workflows): add vsce-package called on PR created
  - Commit: d49afac851a3d0abaaeea6c93dbb5e5c4f49126f
- feat: init extended api
  - Commit: e4b19294c74eb3276b099f775e69b1a0ba78f77e
- feat(pro): support import file via another project/external url
  - Commit: 5f503d2be0194af67acb5def2adc3c2214d0e146
- docs(pro): update docs for pro feature - external file
  - Commit: 69df7f8ae018e74dcc6c7098b62dd839a4eed74e

### Changed
- chore: update l10n file and l10n
  - Commit: e7cfcf3a39a4c09b954aec76e79d829f6fbf2f21

### Fixed
- fix(views/pdf-viewer): cross-site scripting vulnerability
  - Commit: 24eee8ee0f7a984e00c0eefcbe7aa22ee05e62f6
- fix(pro): validate file name when create linked file
  - Commit: cbe8b380bb16048ff6bc956d9883b1f0aa779050
- fix(pro): show tags when choose another project
  - Commit: 83bf00b722bb4b3851553be53a387546a05c84c1

## [0.7.0] - 2023-12-29
### Added
- feat: integrate invisible mode
  - Commit: fbaabd724e5ca09895efc84e92516c7f0ff86420

### Changed
- chore: cleanup triggers register
  - Commit: cbc282c8302a98a0bad3450784fbb3ebc55e9869
- chore: disable entry for incomplete feature tether
  - Commit: 301a1a2b4eeda2f95915446814e9aa7bbe1504b9

## [0.6.1] - 2023-12-18
### Fixed
- fix: pdf viewer color theme bug
  - Commit: 3c63a0d777b9dd0002d8dcd9a7f23a5ab194e404

## [0.6.0] - 2023-12-18
### Added
- feat: chat view support up/down key navigating
  - Commit: a1c80b98f2ce219ccc19adfbb8b56095938d0a9b

### Fixed
- fix: pdf viewer color scheme
  - Commit: 717d9179e21fc708226d568e2b7e90c024eaa800

## [0.5.5] - 2023-12-16
### Added
- feat: local replica better overwriting
  - Commit: 056c18f2df6af96abdfd6d5fcd7b7a3d43b2688f
- Add latex doc symbol provider
  - Commit: 4058609de268748428390c7779b8def9baab66d2
- add tex doc formatter
  - Commit: 31f76d7c3df25958fd66cb9494751c642fa03881
- feat: alternative socketio interface
  - Commit: 1b4c94399d4f01ae67fd25c1e213cf9d120caa08
- feat: socketioAlt refresh messages and project settings
  - Commit: 5aa8ed4376a33688fdb967189a4882e7711c0a48
- feat: socketioAlt refresh vfs and users
  - Commit: 91d70959689dca3f87d8b26744ab1e8911c753d7
- add log, add input support, fix symbol string func call bugs
  - Commit: ba4db462e5f7d54a31dffbc8427523ea7436b607

### Changed
- chore(deps-dev): bump vite from 4.4.11 to 4.4.12 in /views/chat-view
  - Commit: 29d51aaedcf4e6da19822e42227eb666fe845bbf

### Fixed
- fix: move/copy files between vfs
  - Commit: 8cafb87fbb7481ab29c551953b028fe7c36032a0
- fix: hierarchy symbol mismatch
  - Commit: e1023c078a3dc2e81454246a606433a2c28f95ff
- fix: resume socketio handlers mem leak
  - Commit: 9c313b3cd5314ea5060a6781aa29cd15bfc10949
  - Commit: 8fd39ce3652426b8099c009ff665e31e9eefd3ec

## [0.5.4] - 2023-12-07
### Changed
- chore: improve accessibility
  - Commit: 7110ff9d55c516a7cf9430b083a6ea2ab9218e82

### Fixed
- fix: bug due to previous refactor
  - Commit: 5c88a255df2e35b819f3480fcacacfb42a812578
- fix: add timeout reject for socketio emit
  - Commit: d3dd2b0985b34d892f69424058a8c99fb81a7406

## [0.5.3] - 2023-12-04
### Added
- feat: allow jump to user via command
  - Commit: 5868168f11f95db7b4c0c47b92765a0e686e2215

### Changed
- chore: normalize command register
  - Commit: 85879c07032f1c2ba8cb0fe0678b350bbfa1a945
- chore: timeoutPromise type inference
  - Commit: d4216d52ad728b0ce8800e3a744feb54dfd0ad10

### Fixed
- fix: normalize command display in command palette
  - Commit: 8d44c255800c731e3b5e2fe0764285b72aaf5146
- fix: add timeout for joinProject
  - Commit: 79d4f728f8bd8ca2180e4afe6db18c547edf7493
- fix:reconnect issue
  - Commit: 4049dd774ceb8f3351001c079ba93745ff79daf5
- fix: focus on chat input box
  - Commit: 031154ad83fda62d2cfc08b8fe919f49c5f40d94

## [0.5.2] - 2023-12-01
### Fixed
- fix: fetch project with multiple tags
  - Commit: da7e331bfb23878096da4ab07bbfac0c399a6442

## [0.5.1] - 2023-11-30
### Added
- feat: allow enable/disable scm
  - Commit: dbf1e048c63e6efeec150ff0d96f7dc91b9294f9

### Fixed
- fix: restore pdf viewer scroll position
  - Commit: 265fe3b2304d89b346b7aae5f7a4325ae5685942
- fix: socketio connection procedure
  - Commit: 760875896bba6245f9bc39e145a5bd91b2e97a8f

## [0.5.0] - 2023-11-28
### Changed
- chore: promote local replica
  - Commit: ce95c3e370662c0943b04a693a1ecd753ae95c9f

### Fixed
- fix: pdf viewer init theme button
  - Commit: ffbf91c1c60f7566d488f21d1c7e82b006ee85b3

## [0.4.4] - 2023-11-20
### Changed
- chore: adjust UX
  - Commit: 75876e9a70ca177e1241d5096702dd6fd390438d

## [0.4.3] - 2023-11-20
### Added
- add reload
  - Commit: b1c7078199a2ae42f53252525ba3a327eb661e22

### Changed
- chore: adjust pdf viewer dark theme
  - Commit: 191ab2aa930564d7283c48c4c36e5fc7b598149b

### Fixed
- fix: local replica path parse failure
  - Commit: 57ec738cad06c215d67f01c0bff0429c1432de77
- fix: pdf viewer state resume
  - Commit: 2ef8a5d4654ea29ad5b9b48da3bc88ca5a060753

## [0.4.2] - 2023-11-18
### Added
- feat: support project upload
  - Commit: 53d85fd4734a026e97551da1bf6383eaf382523b
- feat: support project download
  - Commit: 3e5ebb238205b72790975d90b7168100a66a0079
- feat: allow to show all key versions
  - Commit: cda67d1f87d9f2116317a4f7914e4400605cd953
- feat: feat: more diff actions
  - Commit: 79fb4945e407c1458cc825e4291e96cbfb75c0c8
- feat: init scm api design
  - Commit: e60dbd6bcc05ac16a22a6205efa860608a53b393
- feat: support local replica scm
  - Commit: fdfb2decbfbfd98c523a7b43ca6c30b6a447b977
- feat: support scm status bar item
  - Commit: bacd53ab58de77335efbe3f5a01a6971ce102b65
- feat: open locally with vfs support
  - Commit: 0cbf07aca4a92d9104cc0ccba272a46ab540db27

### Fixed
- fix: command completion
  - Commit: ca47750215ad5e1fac7977ad62c7face3921bf0b
- fix: compile script order
  - Commit: b8b711a107030a0122079c66e3400599136a8eb1
- fix: npm script run under windows
  - Commit: 2981adf8739d5931c9d839d4321b115ca0b2a93a
- fix: use Uri.path for cross-platform consistency
  - Commit: b2516e18faeca8c7e25af3253e3fea6070d35c13

## [0.4.1] - 2023-10-30
### Added
- feat: support project settings
  - Commit: 8d2ace909e71bd5bdde97d14f48d71043696dff5
- feat: unlearn words
  - Commit: bc39e015f1713e459578ece0c8052bdd29faf128

### Changed
- chore: show email in project list
  - Commit: bf7aad1c9c1939d272dfab604e5ecc31b95a3ae2
- refactor: decouple the design
  - Commit: 1c2afeb6332ac99597c7fa9f28ab6d72d5b51b59

### Fixed
- fix: load online cmaps for pdfjs
  - Commit: c03146b0e9f52b192f0ac38d4fb40af114969404

## [0.4.0] - 2023-10-25
### Added
- feat: support line reference
  - Commit: 011603c97babd51ba1019ccaa62213a1384902b6
- feat: support cite user
  - Commit: 045858aa91dd1f17e7bb2b55f2a2898b4eb8e1cf
- feat: notify new message and scroll into view
  - Commit: 9bc376451256e0ccec223b0e7e5ff3af4c2ea060
- feat: notify new message on status bar
  - Commit: cbaee4e8d749477e32daa200fa188bc2e64ff6d6

### Fixed
- fix: spell check word split
  - Commit: 13a7134b26ec9e5ef8cecfd9f1dca240f5287498

## [0.3.3] - 2023-10-23
### Fixed
- fix: response to spell check language change
  - Commit: 0f8575cb5e4cd1a36d0b07c19f58f28be3cd2cae

## [0.3.2] - 2023-10-23
### Added
- feat: init chat view
  - Commit: 9a9ee85c284c721e875bb751b536312845dffff9
- feat: update input box view
  - Commit: b36e62f807fe15422639027ebee27e0bdbf3da3f
- feat: complete basic function
  - Commit: 884a80a6235597ef644f14f72ed4d5b41d08100d
- feat: support reply in thread
  - Commit: 7a5c0feb70317f4cd51da8b6aa131797975f595f
- feat: add overleaf official as default server
  - Commit: 06126d0eb693f18e14c9aa0b35925575f45cdbfc

### Changed
- chore: login prompt
  - Commit: 2c96fb95e596b8ab26ec883f3fb16c435e14305c

### Fixed
- fix: clientAgent multiple register
  - Commit: d822c96a7df5ae2e405f056ad35d9ebccefcda13

## [0.3.1] - 2023-10-17
### Added
- feat: add chat messages api
  - Commit: 80afcfd09f0cf488ceeddc4286c614bb20eb6ab7
- init chat webview
  - Commit: 37fb201d783f0d2007bd8f0dd119cf3a3d727b71
- enable socketio reconnect
  - Commit: 359270cdb793d9fc70cf6d3268b3286ab9cf8e3e

### Changed
- refactor: make views/pdf-viewer standalone
  - Commit: f1cade53eb8cc3633cd9e20327231535fad101ce
- chore: update vue build
  - Commit: 2267d599cd05879dd1095d6348d552dcd59c3b68

## [0.3.0] - 2023-10-04
### Fixed
- fix: handling socketio ascii content
  - Commit: a615cb6f318329f370733d4bd15cd862ca6b0d30

## [0.2.6] - 2023-09-30
### Added
- robust cookie login
  - Commit: 746dc3980b71477a40516922136c74c279c8896c

## [0.2.5] - 2023-09-30
### Added
- feat: use active user color on status bar
  - Commit: 48d6371410c3978d5e98f787c411655ce063d2de

### Changed
- chore: adjust ui
  - Commit: e20ff09e066b035e7da6b552f2e48d6050319aef
- refactor: base api
  - Commit: a754efbbece697b9affdc3550b1ea05634de4926
- chore: add empty file as doc type
  - Commit: 9d33023969127c9300dbce59b753170920f53d1e

### Removed
- remove Diff
  - Commit: b94af16c8bb0d09594a85c00dd4ce33d1f42481e

### Fixed
- fix: decoration local expand behavior
  - Commit: 461c709448c0e04f644bd79d005eff6f01bef2c0
- fix: spreadMode not stored
  - Commit: efbfccb29f2dfca951084cdd56dedb9e8f43d266
- fix: update patch
  - Commit: 716df46f5eb6cfdde10b2cf80c4cff0c2eaf50c9

## [0.2.4] - 2023-09-24
### Added
- handle out-of-sync
  - Commit: 1bcc0e062936eb0b32cc1b0ad4ea0f5c90e54bf6

## [0.2.3] - 2023-09-24
### Added
- feat: add history related api
  - Commit: dfe869eaeb368b4c433e0669d7d5ca281a9d8c82
- feat: add fileWillOpen event
  - Commit: cf2397dd68cee42ac881412d9b01b8c291c3a828
- feat: init history view support
  - Commit: 1e1e6a687b35301df62f230d7355228696cfa11d
- feat: history label management
  - Commit: 8589de0c31c98c3b8c8d16892de4bca781ff207f

### Changed
- chore: cleanup compileManager triggers
  - Commit: 2d0a2b6852f5c5f6d2cb2abfa5e8da5650c94b39

## [0.2.2] - 2023-09-22
### Added
- feat: project tag management
  - Commit: 7ce700d8e9284b49144450b6b2e09adca30c2dd0

### Changed
- chore: improve statue bar experience
  - Commit: 02a383a3854e335898670ace8b831f7e498e553d

## [0.2.1] - 2023-09-21
### Added
- feat: display users on status bar
  - Commit: a5a97e5486c7c321e172d9af8086c2ef8f27cfde
- feat: render colorful online user cursors
  - Commit: 9416ac82c082e04fb09adf0511bffcf09bb06693

### Changed
- refactor: compile-related code to separate folder
  - Commit: 28ec309a1325cbccffb005bc4c898c70a5c49318

## [0.2.0] - 2023-09-19
### Added
- feat: support cookies-based login
  - Commit: 46b804c293e46327f525a57fcc7e02d35b2b4453
- feat: support get projects fallback
  - Commit: dd94de192f6500a733b45e1c657d57ae29ee60ec
- add compile error display
  - Commit: a0bc9faf94193cc7143c8bf259689aa08213314d

### Changed
- chore: adjust pdf viewer theme
  - Commit: 45c9d852c1f47edcc47350bfdafdb1e23ce5f261
- chore: prompt text
  - Commit: 5424dd38284f396b24cf16a9cb993b101a0f91d3

### Fixed
- fix: snippet completion range
  - Commit: 782eb0458ac7cb0d2a12f367c23679e25b6b6972
- fix: pdfjs font color always mono
  - Commit: c2a7473995d0fcee38cf8dd2a8600be7e4261afc

## [0.1.5] - 2023-09-17
### Added
- feat: support command intellisense
  - Commit: 924e2c0cda281895424458a09c18195369486fd7

### Changed
- chore: default output folder name
  - Commit: d917bf75cbb70e794a618ded93577505a86d9c47

### Fixed
- fix: init user dictionary
  - Commit: 62dea4598e2ea95573d371fe3fb6657c0ef2fa89
- fix: completion trigger and filter
  - Commit: 7734dd7fc9f3ea7d5a93f9e3a8674c12a4005b79
- fix: spell check range
  - Commit: 3c4c48f4539b76e0d9bb8d13c54b54910e0252b0

## [0.1.4] - 2023-09-15
### Added
- feat: support path intellisense
  - Commit: eb06b5e762c092e0691c86ea9eb961a30228e0f8
- feat: support constant data completion
  - Commit: 0268586ca8fc3a325d28bba224f166d1fa9b1ad4
- feat: support reference completion
  - Commit: d1007acca783522b09cde86f2bed8654ec7b26d9

## [0.1.3] - 2023-09-14
### Added
- add completion data
  - Commit: 2855210497e50a91067d78a98f893ef6615d78e4
- feat: online spell check
  - Commit: 5684e5a9c104037a7060b4f2ba62985f296dd603

## [0.1.2] - 2023-09-12
### Added
- add language definition
  - Commit: a9e8f8a62efa7c635cadee8aa8574b022cd3e305
- update project related api
  - Commit: 659656f2fba5e91d2d045954a0c0eb7f6a955556
- support project CRUD
  - Commit: b45962732c1cd85eed4b16a78d4e5ea636531162

## [0.1.1] - 2023-09-10
### Added
- patch pdfjs to support themes
  - Commit: c5467ee9360d62926e54d5661739bb0fbec633dc
- support pdf viewer dark mode
  - Commit: 9c5b0cee0c6f268f073ea1c423879a78f1ea7162

## [0.1.0] - 2023-09-09
### Added
- update reverse sync
  - Commit: 4e7f3a5ee5085656630a51b38147dcb1b22c004b
- add explicit syncPdf/syncCode function
  - Commit: 8c08af0d68341fc80ffed3cd795d4fe4e12f87d6

### Changed
- keep pdf viewer state when reload
  - Commit: 4649900b7e74551c9334adf2771a25a0581cda06

### Removed
- disable pdfjs useless services
  - Commit: 781ad5b78c24320615710192fa7afe141f6bf420
- remove implicit root_name usage
  - Commit: 9d7f1840156911001c343f7d0c2b62c18038e877

### Fixed
- fix file open column issue
  - Commit: da93c0721ae558d1f1e04a9b20c7b5d0cf1951ea
- fix bib file reverse synctex
  - Commit: 777ff15048a172f158f51157e3995c45517ec5a0

## [0.0.6] - 2023-09-06
### Added
- init editor-side syncCode/syncPdf
  - Commit: d7b994fd4927e9378b92e9be588a3bd907ceb4be

### Fixed
- fix output pdf view priority
  - Commit: e581bdcc013b02fa572d1a6398dfd400bef6026e
- use pdf.js in correct way
  - Commit: 45189687caa43da659d3e070785c70b4dae90700
- fix pdf refresh uncaught exception
  - Commit: c9f02bc5eba9304dd62e2ffbd762d3fd9605be5f
- fix refresh issue
  - Commit: 359a5b17c91d8d7707b2fbbfa2806bc8bb42d267
- fix compile condition
  - Commit: 51631835ebfa80a5d9650e07c14e8924b72be08a

## [0.0.5] - 2023-09-05
### Added
- add view pdf keybinding
  - Commit: 8b10a5310a2cef27ac496afe49e74bf3dda2b11f
- init pdf view support
  - Commit: 482dc3922216548a883d540ab9ca058ce6dc099a

## [0.0.4] - 2023-09-04
### Added
- add compile manager
  - Commit: 10503b7f163d5e2177681bd8cb0648e8c0777fec

### Fixed
- fix: getFileFromClsi
  - Commit: 5d57fb4a6ef8b9b90fd629111b37d9028a54ad3f
- fix doc dirty check
  - Commit: cc3379bb408df7b0f8bfc15e8389b14ce390aa17
- fix file update notify
  - Commit: ab7a86202881c9618ad8e1eda7d7a80386d44af5

## [0.0.3] - 2023-09-03
### Added
- add compile results in folder
  - Commit: 2f9039bcf2a050c55b13176d71fbb5e5f8dc140e

### Removed
- remove docs from package
  - Commit: 404e3b333bde46bcfeddd36f3fe9fccc6a40eec4

### Fixed
- fix doc update change
  - Commit: 90b35a8ba206a152269d7af2c6e6609eae5b345d
- fix open project behavior
  - Commit: 1278aebc42e27ff9721aad58d7537352451bcce6
- fix get file encoding error
  - Commit: 7e2c72ed65e4cf1df966f3b4b29a69209599b0c1

## [0.0.2] - 2023-09-02
### Added
- Create LICENSE
  - Commit: 52a2587806aa8bd0f53395bd4f41c590dc48e37f

### Changed
- update vscode publisher name
  - Commit: 4672c84ad25448009732e471d3ea1e1b21fc3eec

### Fixed
- fix publish issue
  - Commit: e6a7ac99586840dbdd2f19d5496b49db23506037
- fix package compile issue
  - Commit: 98a36687bcc8206eb00d624eb5dba885497caf6a

## [0.0.1] - 2023-09-01
### Added
- init project structure
  - Commit: 1bc8537a0e2f74f361e9f5d5fa9482bdd058edd3
- update project structure
  - Commit: c1af594e158f92050d9284c308727c9d3a3c515e
- refactor BaseAPI
  - Commit: a7c1e056948edbed878081a79262458f90306752
- add refresh function
  - Commit: ba16d601e135dbae2c33a5c38ee4b8e051857e32
- update userId api
  - Commit: 6cc82e04a169bd079876950631d70c2276bfb8a2
- use correct socket.io with patch
  - Commit: 5f50b93e11c2e5e571cf52c27c0a9c86465b019f
- add socketio api
  - Commit: a1d25bbe1810ae06be6bb13931f201fa9d541c0b
- init integrate with vfs
  - Commit: 92608ce2c825584f525c63f71f99821c1b29da1f
- complete vfs read
  - Commit: 636517a7b2d321d5f8368a7454bdd82f80a05e5c
- add file download api
  - Commit: 3f6b81f3e57239d7e31d2711cd394e1f3e35abe8
- add addFolder api
  - Commit: 017815da5d158747acf48708df3013528ed98ced
  - 595235e0a50169e8af7126b36ed92ef2097e4b72
- add deleteFile api
  - Commit: 5d3de0f20ccd32d322ba13629f082934ec4a5cb3
- add rename api
  - Commit: 42e54e82af3b3513fed035f606a891780dafb933
- add file upload method
  - Commit: ee0efcb989c5c27ad5ca37dafe96ca3e2a4e4cbf
- add otUpdateApplied event
  - Commit: 0b4e56ad251c7879676a7560ed1bf92728c7dc81

### Fixed
- fix csrf check
  - Commit: 8067427769c577c50ac711e5c42eda658264de7c
- fix: moveEntity
  - Commit: 7a17be1fe77578764a48895c75ad7e17b59f0aac
- fix create file
  - Commit: 21bede9fbc6e26f811721894547683a9e07940d0
- fix: writeFile
  - Commit: 14987ba52c8bca29e09be5815d18eff23e354718
- fix doc version starts with 0
  - Commit: fed6a79f3cc5549d0435838aa6f2e569e25c55a4
