const roomInput = document.getElementById('room');
const dateInput = document.getElementById('date');
const startTimeInput = document.getElementById('start-time');
const endTimeInput = document.getElementById('end-time');
const purposeInput = document.getElementById('purpose');
const participantInput = document.getElementById('num');
const specialRequestsInput = document.getElementById('requests');

const summaryRoom = document.querySelectorAll('.summary-value')[0];
const summaryDate = document.querySelectorAll('.summary-value')[1];
const summaryTime = document.querySelectorAll('.summary-value')[2];
const summaryDuration = document.querySelectorAll('.summary-value')[3];
const summaryPurpose = document.querySelectorAll('.summary-value')[4];
const summaryParticipants = document.querySelectorAll('.summary-value')[5];
const summaryRequests = document.querySelectorAll('.summary-value')[6];

function formatRoomLabel() {
  if (roomInput && roomInput.selectedOptions && roomInput.selectedOptions[0] && roomInput.value) {
    return roomInput.selectedOptions[0].textContent.trim();
  }
  return '-';
}

function formatDate(dateValue) {
  if (!dateValue) return '-';
  const date = new Date(dateValue + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return '-';

  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

function formatTimeRange(startValue, endValue) {
  if (!startValue || !endValue) return '-';
  return `${startValue} - ${endValue}`;
}

function calculateDuration(startValue, endValue) {
  if (!startValue || !endValue) return '-';

  const parseTime = (timeString) => {
    const [time, modifier] = timeString.split(' ');
    let [hours, minutes] = time.split(':').map(Number);

    if (modifier === 'PM' && hours !== 12) hours += 12;
    if (modifier === 'AM' && hours === 12) hours = 0;

    return hours * 60 + minutes;
  };

  const startMinutes = parseTime(startValue);
  const endMinutes = parseTime(endValue);
  const diffMinutes = endMinutes - startMinutes;

  if (diffMinutes <= 0) return 'Invalid range';

  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;

  if (hours && minutes) return `${hours} hr ${minutes} mins`;
  if (hours) return `${hours} Hour${hours > 1 ? 's' : ''}`;
  return `${minutes} Minutes`;
}

function updateSummary() {
  summaryRoom.textContent = formatRoomLabel();
  summaryDate.textContent = formatDate(dateInput.value);
  summaryTime.textContent = formatTimeRange(startTimeInput.value, endTimeInput.value);
  summaryDuration.textContent = calculateDuration(startTimeInput.value, endTimeInput.value);
  summaryPurpose.textContent = purposeInput.value.trim() || '-';
  summaryParticipants.textContent = '1 User';
  summaryRequests.textContent = specialRequestsInput.value.trim() || '-';
}

function resetSummary() {
  summaryRoom.textContent = '-';
  summaryDate.textContent = '-';
  summaryTime.textContent = '-';
  summaryDuration.textContent = '-';
  summaryPurpose.textContent = '-';
  summaryParticipants.textContent = '1 User';
  summaryRequests.textContent = '-';
}

[roomInput, dateInput, startTimeInput, endTimeInput, purposeInput, participantInput, specialRequestsInput].forEach((input) => {
  if (input) {
    input.addEventListener('input', updateSummary);
    input.addEventListener('change', updateSummary);
  }
});

const resetButton = document.querySelector('.reset-button');
if (resetButton) {
  resetButton.addEventListener('click', () => {
    setTimeout(resetSummary, 0);
  });
}

updateSummary();

function loadUserProfile() {
  const savedUser = localStorage.getItem('currentUser');
  if (savedUser) {
    const user = JSON.parse(savedUser);

    const nameElement = document.querySelector('.student-name');
    const courseElement = document.querySelector('.student-course');

    if (nameElement && user.username) {
      nameElement.textContent = user.username;
    }
    if (courseElement && user.studentNum) {
      courseElement.textContent = user.studentNum;
    }
  }
}

loadUserProfile();