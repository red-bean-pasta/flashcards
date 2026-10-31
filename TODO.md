# TODO

- [ ] Find a supported way to start the OneDrive Personal picker in the app folder. Its documented folder entry applies to Business and was ignored in Firefox; a picker URL experiment passing the app folder ID was redirected to root.

- [ ] Verify the picker start-location request and folder selection with renewed broad consent in a regular browser.

- [ ] Test pending mutations on a real mobile device when the browser is suspended and resumed, including a reload and a matching-folder reconnect. Confirm retry timing, recovery, and preservation of practice progress during in-place updates.
- [ ] Exercise difficult recovery cases against a disposable live OneDrive folder: responses lost before and after a write, interruption between archive and source writes, and concurrent external edits. Current automated fixtures cover these paths, but live service behavior has not been verified for each case.
