(function () {
  const form = document.querySelector("[data-checkout-form]");
  if (!form) return;

  const processingMessage = form.querySelector("[data-processing-message]");
  const processingCopy = form.querySelector("[data-processing-copy-text]");
  const buttons = form.querySelectorAll("button[type='submit']");

  form.addEventListener("submit", function (event) {
    if (form.dataset.ready === "true") return;

    const submitter = event.submitter;
    if (!(submitter instanceof HTMLButtonElement)) return;

    event.preventDefault();
    form.setAttribute("aria-busy", "true");
    buttons.forEach(function (button) {
      button.disabled = true;
    });

    if (processingMessage) processingMessage.hidden = false;
    if (processingCopy && form.dataset.processingCopy)
      processingCopy.textContent = form.dataset.processingCopy;
    submitter.textContent = submitter.dataset.processingLabel || "Processing…";

    window.setTimeout(function () {
      form.dataset.ready = "true";
      // Disabled buttons are omitted from the submitted form data.
      submitter.disabled = false;
      form.requestSubmit(submitter);
    }, 450);
  });
})();
