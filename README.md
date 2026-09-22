# NUFV LRC SYSTEM

The NUFV Library Room Reservation System is a completed web-based reservation platform developed for National University Fairview students. It provides a centralized and user-friendly system for managing library study-space reservations and related student services.

The system allows students to create and manage their accounts, browse available spaces, and make reservations through an organized dashboard. Firebase is used as the backend to support user authentication, cloud data storage, and the management of reservation and service-related information.

The platform includes multiple reservation and utility services designed to support different student needs. These services provide dedicated workflows for discussion spaces, computer rooms, and silent study rooms, as well as a Wi-Fi voucher generation feature.

## Group Members

- Shaira Mae Aton
- Sean Cedwin Custodio
- Seane Kyle Reyes
- Jehiel Rosario
- Samuel Rick Salud

## Technologies Used

- **HTML5** - Structure and content of the web pages
- **CSS3** - Layout, styling, responsive design, forms, and user-interface components
- **JavaScript** - Client-side interactions, form validation, reservation workflows, dynamic summaries, date/time handling, and interface behavior
- **Firebase Authentication** - User registration, login, and account authentication
- **Firebase Firestore** - Cloud database for user, reservation, room, and service-related data
- **Firebase** - Backend services and cloud integration
- **Font Awesome 6.5.2** - Interface icons
- **Google Fonts (Poppins)** - Typography and visual styling
- **SVG/JPG Assets** - National University branding and interface imagery

## Main Features

### User Account Management
- Student registration
- Student login
- Password reset
- Authenticated user access
- Student dashboard

### Room Reservation Services
- **Library Discussion Room Reservation** - Reserve discussion rooms by selecting the desired room, date, time, purpose, number of participants, and special requests
- **Computer Room Reservation** - Reserve available computer rooms for academic activities and other permitted student purposes
- **Silent Room Reservation** - Reserve designated silent study rooms for individual or focused study sessions

### Wi-Fi Voucher Generator
- Generate Wi-Fi vouchers for authorized students
- Manage voucher information through the system's backend
- Provide students with access credentials for library Wi-Fi services

### Reservation Management
- View available rooms
- Select reservation date and time
- Calculate reservation duration
- Display reservation summaries
- Store reservation information in Firebase
- Manage reservation records through the connected backend

### Additional Features
- Responsive student-oriented interface
- National University Fairview branding
- Terms and conditions
- Form validation and input-state feedback
- Password visibility toggle
- Organized navigation and dashboard interface

## System Backend

The system uses **Firebase** as its cloud backend. Firebase Authentication handles user account authentication, while **Cloud Firestore** provides persistent storage for user and reservation data. This backend integration allows reservation records and other system information to be stored and accessed across the application's supported workflows.

## Project Status

**Completed** - The NUFV Library Room Reservation System includes the student-facing interface, reservation services, Wi-Fi voucher generation, Firebase authentication, and cloud-based data management required for the completed project.
