# Security

## Reporting a problem

Please report security problems **privately**, not in a public issue:

1. Open the repository's **Security** tab and choose **Report a vulnerability**
   (or go to https://github.com/zhenban/lite-player-for-echo360/security/advisories/new).
2. Describe the problem, how to reproduce it, and what an attacker could do with it.

You will get an answer in the advisory. Please give a reasonable time to fix the problem
before telling others about it.

## What counts

Examples of what to report: a way for a web page or another script to make Lite Player for Echo360
send data somewhere other than Echo360, write to Echo360 without the user's action (notes,
discussion posts, flags), read data it should not, or run code it did not intend to run
(for example through a library loaded at run time).

Problems in Echo360 itself should go to Echo360, and problems in the libraries this script
loads (hls.js, pdf.js, Tesseract.js) to those projects.

## Supported versions

Only the latest release gets security fixes.
