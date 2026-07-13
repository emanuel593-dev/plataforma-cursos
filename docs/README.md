# Technical Documentation

This directory contains public technical documentation for the platform architecture.

## Key Documents

### 📋 Authorization & Access Control
- **[AUTHORIZATION_MATRIX.md](AUTHORIZATION_MATRIX.md)** — Complete RBAC matrix showing role-based access across all features (coordenacao, professor, monitor, student)

### 🏗️ Architecture & Design
- **[IMPLEMENTACAO_MODALIDADES.md](IMPLEMENTACAO_MODALIDADES.md)** — Implementation of lesson modalities (presencial, híbrida, remota) with technical decisions
- **[MIGRACAO_SFU.md](MIGRACAO_SFU.md)** — Design document for WebRTC SFU (Selective Forwarding Unit) migration strategy

---

## For Deeper Understanding

To understand the system architecture better:

1. **Database Schema** — Review [../supabase/migrations/](../supabase/migrations/) for:
   - Table relationships and RLS policies
   - Complex business logic in SQL functions
   - Attendance automation and integrity constraints

2. **Frontend Architecture** — Check [../src/](../src/) for:
   - React component hierarchy and state management
   - WebRTC peer connection handling
   - Real-time synchronization with Supabase Realtime

3. **Backend Functions** — See [../netlify/functions/](../netlify/functions/) for:
   - Authentication and authorization patterns
   - Integration with external services (Resend, Google Drive, Cloudflare TURN)
   - Server-side request handling and validation

4. **Testing & Validation** — Review test infrastructure in [../src/test/](../src/test/) and vitest configuration

---

*Last updated: 2026-07-13*
