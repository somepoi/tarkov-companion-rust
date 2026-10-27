# Selected-container screenshot input

This implements the capture-to-selected-container seam from migration phase 9 on top of the native capture/hotkey integration and the full-container selection workflow. It does not claim that automatic change detection or multi-view registration is complete.

## Capture destination

The user explicitly arms the current draft using its container name. A lightweight renderer router has at most one mounted recipient and retains neither images nor a saved target. Leaving the page, changing mode, ending the session or disarming releases the recipient. Starting/resuming a different draft requires arming it again. Captures without an armed recipient retain the original Item Collection workflow. An already-open Item Collection scanner keeps priority over a background stash recipient.

Received PNG bytes use the existing host capture and binary IPC path. The stash recipient archives/stages the image through the same function as a file import. The selected container is visible during area/recognition review; no capture commits inventory automatically. Captures during another stash operation are discarded with an explicit retry message rather than creating an unbounded queue or replacing in-flight results.

The review fieldset also accepts clipboard images and dropped files. These inputs use the same archive validation, single-job guard, staging and reviewed replacement rules. Dropping a file prevents browser navigation; unsupported data produces an archive/import error. Closing or replacing the screenshot selector leaves existing draft rows intact.

## Verification boundary

Source review, type checking, lint, frontend/native builds and the bounded design detector are compilation/source evidence. They do not establish actual Windows hotkey routing, clipboard/drop behavior or capture accuracy. Per the user's instructions no tests or real screenshot checks are run. Automatic recognition using a saved registration and confirmation before commit remain separate work; the current input enters the explicit area/review stage.
