import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDj4IiXIQGwcQeZuDeIePP0zlXb9_ix-rw",
  authDomain: "nufv-lrc-system.firebaseapp.com",
  projectId: "nufv-lrc-system",
  storageBucket: "nufv-lrc-system.firebasestorage.app",
  messagingSenderId: "732754706514",
  appId: "1:732754706514:web:fee781e77302dc6a155f8b"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);