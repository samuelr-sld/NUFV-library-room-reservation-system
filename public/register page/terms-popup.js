// Opens the Terms and Conditions dialog from the registration form (kept out of the page so a strict CSP can forbid inline scripts).
const termsLink = document.getElementById('terms-link');
const termsPopup = document.getElementById('terms-popup');

termsLink.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    termsPopup.showModal();
});

document.getElementById('terms-popup-close').addEventListener('click', () => {
    termsPopup.close();
});

termsPopup.addEventListener('click', (event) => {
    if (event.target === termsPopup) termsPopup.close();
});
