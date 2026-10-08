---
id: example-home
title: The home page opens and reads well
role: none
viewport: phone
start: /
---

<!-- Files starting with "_" are skipped by `affidavit run --all`. Copy this
     file to a new name, then edit it. Everything here is written in the words
     on screen: no selectors, routes, file or table names. This app has no
     sign-in, so `role: none` (the default from the config) is all a spec needs. -->

## Goal
A visitor opens the home page on a phone and can read what the site is about.

## Steps

### 1. Look at the home page
- do: wait for "Home"
- expect: The page's main heading is visible and nothing is cut off at the edges.

### 2. Scroll to the bottom
- do: scroll to "©"
- expect: The footer is visible and the page did not show an error on the way down.

## Success criteria
- The home page is readable on a phone from top to bottom.

## Failure signals
- Any error message, error code or "Something went wrong" screen.
- Text that overlaps or runs off the edge of the screen.
