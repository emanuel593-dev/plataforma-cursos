# VoxTranscribe Pro

VoxTranscribe Pro is a high-performance, real-time voice and video transcription platform powered by the **Google Gemini Live API**. It combines advanced AI processing with robust video conferencing capabilities to provide seamless transcription, analysis, and summarization of live meetings and recordings.

## 🚀 Key Features

- **Real-time AI Transcription**: Powered by Gemini Live API for low-latency, multimodal processing of audio and video frames.
- **Video Conferencing**: Built-in WebRTC-based conferencing with support for multiple participants.
- **Screen Sharing**: High-quality screen capture for presentations and collaborative workspace analysis.
- **Session History**: Automatic saving of sessions to Firebase Firestore, including full transcripts and AI-generated summaries.
- **Mobile Optimized**: Responsive design with a "mobile-first" approach for headers, sidebars, and video grids.
- **Studio Quality Audio**: Captures audio at 48kHz/16-bit for maximum AI accuracy and recording clarity.
- **Smart Workspace**: Integrated dashboard for managing past sessions and analyzing meeting insights.

## 🛠 Tech Stack

- **Frontend**: [React 19](https://react.dev/), [Tailwind CSS 4](https://tailwindcss.com/), [Framer Motion](https://www.framer.com/motion/).
- **Backend**: [Express](https://expressjs.com/), [Socket.io](https://socket.io/) (WebRTC Signaling).
- **Database & Auth**: [Firebase](https://firebase.google.com/) (Firestore & Authentication).
- **AI Engine**: [Google Gemini Live API](https://ai.google.dev/) (`@google/genai`).
- **Communication**: WebRTC (P2P Mesh), Socket.io (Signaling Server).

## 🏗 Architecture Overview

### Frontend (SPA)
The application is built as a modern Single Page Application (SPA). It manages complex states for WebRTC connections, AI streaming sessions, and real-time UI updates.

### Backend (Signaling Server)
An Express server handles the initial HTTP requests and serves the frontend. It also hosts a Socket.io server that acts as a signaling channel for WebRTC, allowing peers to exchange SDP offers/answers and ICE candidates.

### AI Integration
The app uses the `@google/genai` SDK to connect directly to the Gemini Live API. It streams raw PCM audio and JPEG video frames to the model, receiving back real-time transcriptions and intelligent responses.

### Data Persistence
Firebase Firestore stores user profiles and session history. Firebase Auth handles secure user authentication via Google and Email/Password.

## 📋 Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Google Gemini API Key
GEMINI_API_KEY=your_gemini_api_key

# Firebase Configuration (Optional if using firebase-applet-config.json)
# VITE_FIREBASE_API_KEY=...
# VITE_FIREBASE_AUTH_DOMAIN=...
# VITE_FIREBASE_PROJECT_ID=...
```

## 🚀 Getting Started

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn
- A Google AI Studio API Key

### Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure your environment variables in `.env`.
4. Start the development server:
   ```bash
   npm run dev
   ```

### Building for Production

```bash
npm run build
npm start
```

## 📂 Project Structure

- `/src/components`: Reusable UI components (Conference, Auth, Sidebar, etc.).
- `/src/services`: Logic for Firebase and AI API interactions.
- `/server.ts`: Express server and Socket.io signaling logic.
- `/firestore.rules`: Security rules for database protection.
- `/firebase-blueprint.json`: Data structure definition for Firestore.

## 🛡 Security

The project implements **Default Deny** security rules in Firestore. Access to user data and sessions is strictly limited to the authenticated owners. Admin roles are supported for system-wide management.

## 🗺 Future Roadmap

- [x] API & Webhook Integration Support.
- [ ] Multi-language translation support.
- [ ] Advanced participant management (breakout rooms).
- [ ] Integration with Google Calendar and Outlook.
- [ ] Export transcriptions to PDF/Docx.
- [ ] Real-time sentiment analysis dashboard.

---
Developed with ❤️ using Google AI Studio.
