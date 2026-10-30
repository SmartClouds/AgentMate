/**
 * One-click login's form filler. Main injects this file into a login page as a string, through
 * webContents.executeJavaScript (see main/vault/autofill/fillScript.ts), so it must stay plain,
 * self-contained browser JavaScript: no imports, no build-time helpers, nothing from the app.
 *
 * Evaluating the file gives back one function. Main calls it with the page's document and the
 * credentials, and it answers with what it managed to do. It never reads anything from the page
 * back to the app beyond those three yes or no answers.
 */
(function fillLoginForm(doc, creds) {
  const win = doc.defaultView;
  const result = { username: false, password: false, submitted: false };
  // jsdom and pages that haven't laid out yet report no sizes at all, so sizes only count when
  // the page has some.
  const laidOut = doc.documentElement.getBoundingClientRect().height > 0;
  const TEXT_TYPES = ['text', 'email', 'tel'];
  const USERNAME_HINT = /user|e-?mail|login|account|identifier|phone|handle/i;
  const SUBMIT_LABEL = /^(sign\s*in|log\s*in|login|next|continue|submit|sign\s*on)\b/i;

  function shown(el) {
    if (el.disabled || el.readOnly || el.type === 'hidden') return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const style = win.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    if (laidOut) {
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return false;
    }
    return true;
  }

  function hints(el) {
    return [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.autocomplete]
      .filter(Boolean)
      .join(' ');
  }

  /** Types into a field the way a person would, as far as the page's scripts can tell. */
  function setValue(el, value) {
    el.focus();
    // Frameworks like React put their own value property on the element to track changes, so the
    // prototype's setter is the one that really changes what the field holds.
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    el.blur();
  }

  function press(near) {
    const scope = (near && near.form) || doc;
    const buttons = Array.from(
      scope.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'),
    ).filter(shown);
    const label = (el) =>
      (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
    const button =
      buttons.find((el) => SUBMIT_LABEL.test(label(el))) ||
      buttons.find((el) => el.type === 'submit' && el.tagName !== 'DIV');
    if (button) {
      button.click();
      return true;
    }
    if (near && near.form) {
      if (typeof near.form.requestSubmit === 'function') near.form.requestSubmit();
      else near.form.submit();
      return true;
    }
    return false;
  }

  const fields = Array.from(doc.querySelectorAll('input')).filter(shown);
  const passwords = fields.filter((el) => el.type === 'password');
  const password =
    passwords.find((el) => el.autocomplete === 'current-password') ||
    passwords.find((el) => el.autocomplete !== 'new-password') ||
    null;

  let candidates = fields.filter((el) => TEXT_TYPES.includes(el.type));
  if (password) {
    // The username comes before the password, in the same form when there is one.
    candidates = candidates.filter(
      (el) =>
        (!password.form || el.form === password.form) &&
        el.compareDocumentPosition(password) & win.Node.DOCUMENT_POSITION_FOLLOWING,
    );
  }
  const marked = candidates.find((el) => /^(username|email)$/.test(el.autocomplete));
  const hinted = candidates.find((el) => USERNAME_HINT.test(hints(el)));
  // Without a password field it must look like a username, or a search box would get filled.
  const username =
    marked || hinted || (password ? candidates[candidates.length - 1] : null) || null;

  if (username && creds.username) {
    setValue(username, creds.username);
    result.username = true;
  }
  if (password && creds.password) {
    setValue(password, creds.password);
    result.password = true;
  }
  if (creds.submit && (result.password || result.username)) {
    result.submitted = press(result.password ? password : username);
  }
  return result;
});
