---
id: example-sign-in
title: A signed-in user lands on the home screen
role: admin
viewport: desktop
start: /
---

<!-- Files starting with "_" are skipped by `affidavit run --all`. Copy this
     file to a new name, then edit it. Everything here is written in the words
     on screen: no selectors, routes, file or table names. -->

## Goal
After signing in, the user sees the home screen with their own name on it.

## Steps

### 1. Look at the home screen
- do: wait for "Home"
- expect: The home screen is shown and no sign-in form is visible.
- expect: The signed-in user's name appears somewhere in the page header or menu.

## Success criteria
- The user is signed in and sees the home screen.

## Failure signals
- Any error message, error code or "Something went wrong" screen.
