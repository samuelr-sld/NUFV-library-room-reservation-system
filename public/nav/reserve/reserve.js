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

const defaultSummary = {
  room: '',
  date: '',
  time: '',
  duration: '',
  purpose: '',
  participants: '',
  requests: ''
};

function formatRoomLabel(value) {
  const roomNames = {
    room1: 'Discussion Room 1',
    room2: 'Discussion Room 2',
    room3: 'Discussion Room 3'
  };

  if (value && roomNames[value]) return roomNames[value];

  if (roomInput && roomInput.selectedOptions && roomInput.selectedOptions[0]) {
    return roomInput.selectedOptions[0].textContent.trim();
  }

  return '';
}

function formatDate(dateValue) {
  if (!dateValue) return '';

  const date = new Date(dateValue + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

function formatTimeRange(startValue, endValue) {
  if (!startValue || !endValue) return '';
  return `${startValue} - ${endValue}`;
}

function calculateDuration(startValue, endValue) {
  if (!startValue || !endValue) return '';

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

  if (diffMinutes <= 0) return 'Invalid time range';

  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;

  if (hours && minutes) {
    return `${hours} Hours ${minutes} Minutes`;
  }

  if (hours) {
    return `${hours} Hour${hours > 1 ? 's' : ''}`;
  }

  return `${minutes} Minutes`;
}

function updateSummary() {
  const selectedRoom = formatRoomLabel(roomInput.value);
  const selectedDate = formatDate(dateInput.value);
  const selectedStart = startTimeInput.value || '';
  const selectedEnd = endTimeInput.value || '';
  const selectedPurpose = purposeInput.value.trim() || '';
  const selectedParticipants = participantInput.value || '';
  const selectedRequests = specialRequestsInput.value.trim() || '';

  summaryRoom.textContent = selectedRoom;
  summaryDate.textContent = selectedDate;
  summaryTime.textContent = formatTimeRange(selectedStart, selectedEnd);
  summaryDuration.textContent = calculateDuration(selectedStart, selectedEnd);
  summaryPurpose.textContent = selectedPurpose;
  summaryParticipants.textContent = selectedParticipants;
  summaryRequests.textContent = selectedRequests;
}

roomInput.addEventListener('change', updateSummary);

function resetSummary() {
  summaryRoom.textContent = defaultSummary.room;
  summaryDate.textContent = defaultSummary.date;
  summaryTime.textContent = defaultSummary.time;
  summaryDuration.textContent = defaultSummary.duration;
  summaryPurpose.textContent = defaultSummary.purpose;
  summaryParticipants.textContent = defaultSummary.participants;
  summaryRequests.textContent = defaultSummary.requests;
}

[roomInput, dateInput, startTimeInput, endTimeInput, purposeInput, participantInput, specialRequestsInput].forEach((input) => {
  input.addEventListener('input', updateSummary);
  input.addEventListener('change', updateSummary);
});

document.querySelector('.reset-button').addEventListener('click', () => {
  setTimeout(() => {
    resetSummary();
  }, 0);
});

updateSummary();
