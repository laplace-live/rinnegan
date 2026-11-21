# @laplace.live/rinnegan

## 0.4.0

### Minor Changes

- 60bf71e: Blur viewer names and UIDs in the HTML report with the 打码 switch
- 60bf71e: Tag every danmaku of a flagged user as 跟队形, +1 or 自己说的 in the HTML report

### Patch Changes

- 60bf71e: Explain in plain words how long a flagged user waits between danmaku
- 60bf71e: Color 跟队形, +1 and 自己说的 clearly apart, with one palette across the HTML report

## 0.3.0

### Minor Changes

- c3397e4: Click to see every danmaku a flagged or 手动融入 user sent in the HTML report
- a2bfd0e: Widen the default detection window from 10 to 60 minutes
- c3397e4: List viewers marked 手动融入 in the HTML report and tag flagged ones

## 0.2.0

### Minor Changes

- 013edab: Catch 自动融入 bots that switch lines in step with other accounts
- 013edab: Mark viewers who mostly copy others' danmaku by hand as 手动融入
- 020e403: Export offline results as an HTML report anyone can open in a browser
- ec57ed0: Read and show times in China time, or another zone set with --timezone
- 013edab: Catch 自动融入 bots that insert 随机字符 into each trending line they copy

### Patch Changes

- caa414b: Show message samples for 自动融入 bots that send each line only once
- 6c15812: Stop flagging joiners and bidi marks that Persian, Arabic or Hindi text needs

## 0.1.1

### Patch Changes

- d1b4fb2: The npm package now includes the example config the README links to
