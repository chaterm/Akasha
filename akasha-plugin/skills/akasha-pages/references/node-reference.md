# 编辑器节点参考

本文件由 `apps/server/src/collaboration/page-edit/node-reference.ts` 从服务端 schema 生成，
请勿手工编辑；运行 `pnpm --filter ./apps/server run skill:node-reference` 重新生成。

共 45 个节点、11 个 mark。「可定位」表示该节点带稳定 `id`，
可作为 `edit_page` 的 `nodeId`；表格单元格按行列坐标定位，database 行列用自己的 id。

## 节点

| 节点 | 分组 | 可定位 | content | 属性与缺省值 |
| --- | --- | --- | --- | --- |
| `attachment` | block / atom | 是 | — | `attachmentId`=required<br>`id`=null<br>`mime`=required<br>`name`=required<br>`placeholder`=null<br>`size`=null<br>`url`="" |
| `audio` | block / atom | 是 | — | `attachmentId`=required<br>`id`=null<br>`placeholder`=null<br>`size`=null<br>`src`="" |
| `blockquote` | block | 是 | `block+` | `id`=null |
| `bulletList` | block list | 是 | `listItem+` | `id`=null |
| `callout` | block | 是 | `block+` | `icon`=null<br>`id`=null<br>`type`="info" |
| `codeBlock` | block | 是 | `text*` | `id`=null<br>`language`=null |
| `column` | block | 否 | `block+` | `width`=null |
| `columns` | block | 是 | `column+` | `id`=null<br>`layout`="two_equal"<br>`widthMode`="normal" |
| `database` | block / atom | 是 | `databaseRow*` | `columns`=[]<br>`id`=null<br>`rowOrder`=[]<br>`title`=""<br>`titleAlign`="left"<br>`views`=[] |
| `databaseCell` | atom | 否 | — | `columnId`=null<br>`value`=null |
| `databaseRow` | — | 否 | `databaseCell*` | `id`=null |
| `details` | block | 是 | `detailsSummary detailsContent` | `id`=null<br>`open`=false |
| `detailsContent` | block | 否 | `block*` | — |
| `detailsSummary` | block | 否 | `inline*` | — |
| `doc` | — | 否 | `block+` | — |
| `drawio` | block / atom | 是 | — | `align`="center"<br>`alt`=required<br>`aspectRatio`=null<br>`attachmentId`=required<br>`height`=null<br>`id`=null<br>`size`=null<br>`src`=""<br>`title`=required<br>`width`=null |
| `embed` | block / atom | 是 | — | `align`="center"<br>`height`=600<br>`id`=null<br>`provider`=""<br>`src`=""<br>`width`=800 |
| `excalidraw` | block / atom | 是 | — | `align`="center"<br>`alt`=required<br>`aspectRatio`=null<br>`attachmentId`=required<br>`height`=null<br>`id`=null<br>`initialScene`=null<br>`size`=null<br>`src`=""<br>`title`=required<br>`width`=null |
| `hardBreak` | inline / inline / atom | 否 | — | — |
| `heading` | block | 是 | `inline*` | `id`=null<br>`indent`=0<br>`level`=1<br>`textAlign`=null |
| `horizontalRule` | block / atom | 是 | — | `id`=null |
| `image` | block / atom | 是 | — | `align`="center"<br>`alt`=required<br>`aspectRatio`=null<br>`attachmentId`=required<br>`height`=null<br>`id`=null<br>`placeholder`=null<br>`size`=null<br>`src`=""<br>`width`=null |
| `listItem` | — | 是 | `paragraph block*` | `id`=null |
| `mathBlock` | block / atom | 是 | — | `id`=null<br>`text`="" |
| `mathInline` | inline / inline / atom | 否 | — | `text`="" |
| `mention` | inline / inline / atom | 否 | — | `anchorId`=null<br>`creatorId`=null<br>`entityId`=null<br>`entityType`=null<br>`id`=null<br>`label`=null<br>`slugId`=null |
| `orderedList` | block list | 是 | `listItem+` | `id`=null<br>`start`=1<br>`type`=null |
| `pageBreak` | block / atom | 是 | — | `id`=null |
| `panel` | block | 是 | `block+` | `bgColor`=""<br>`borderColor`=""<br>`borderStyle`="solid"<br>`borderWidth`=null<br>`id`=null<br>`title`=""<br>`titleBgColor`=""<br>`titleColor`="" |
| `paragraph` | block | 是 | `inline*` | `id`=null<br>`indent`=0<br>`textAlign`=null |
| `pdf` | block / atom | 是 | — | `attachmentId`=required<br>`height`=600<br>`id`=null<br>`name`=required<br>`placeholder`=null<br>`size`=null<br>`src`=""<br>`width`=800 |
| `status` | inline / inline / atom | 否 | — | `color`="gray"<br>`text`="" |
| `subpages` | block / atom | 是 | — | `id`=null<br>`sortBy`="default" |
| `table` | block | 是 | `tableRow+` | `id`=null |
| `tableCell` | — | 否 | `(paragraph | heading | bulletList | orderedList | taskList | blockquote | callout | panel | image | video | audio | subpages | attachment | mathBlock | details | codeBlock)+` | `backgroundColor`=null<br>`backgroundColorName`=null<br>`colspan`=1<br>`colwidth`=null<br>`rowspan`=1 |
| `tableHeader` | — | 否 | `(paragraph | heading | bulletList | orderedList | taskList | blockquote | callout | panel | image | video | audio | subpages | attachment | mathBlock | details | codeBlock)+` | `backgroundColor`=null<br>`backgroundColorName`=null<br>`colspan`=1<br>`colwidth`=null<br>`rowspan`=1 |
| `tableRow` | — | 否 | `(tableCell | tableHeader)*` | — |
| `taskItem` | — | 是 | `paragraph block*` | `checked`=false<br>`id`=null |
| `taskList` | block list | 是 | `taskItem+` | `id`=null |
| `text` | inline / inline / atom | 否 | — | — |
| `toc` | block / atom | 是 | — | `id`=null<br>`maxLevel`=3<br>`minLevel`=1 |
| `transclusionReference` | block / atom | 是 | — | `id`=null<br>`sourcePageId`=null<br>`transclusionId`=null |
| `transclusionSource` | block | 是 | `(paragraph | heading | blockquote | codeBlock | horizontalRule | bulletList | orderedList | taskList | image | video | audio | attachment | callout | panel | details | embed | mathBlock | table | drawio | excalidraw | pdf | subpages | columns | youtube)+` | `id`=null |
| `video` | block / atom | 是 | — | `align`="center"<br>`alt`=required<br>`aspectRatio`=null<br>`attachmentId`=required<br>`height`=null<br>`id`=null<br>`placeholder`=null<br>`size`=null<br>`src`=""<br>`width`=null |
| `youtube` | block / atom | 是 | — | `height`=480<br>`id`=null<br>`src`=null<br>`start`=0<br>`width`=640 |

## Marks

| mark | 属性与缺省值 |
| --- | --- |
| `bold` | — |
| `code` | — |
| `comment` | `commentId`=null<br>`resolved`=false |
| `highlight` | `color`=null<br>`colorName`=null |
| `italic` | — |
| `link` | `class`=null<br>`href`=null<br>`internal`=false<br>`rel`="noopener noreferrer nofollow"<br>`target`="_blank"<br>`title`=null |
| `strike` | — |
| `subscript` | — |
| `superscript` | — |
| `textStyle` | `color`=null |
| `underline` | — |
