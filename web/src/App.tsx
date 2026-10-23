import { Navigate, Route, Routes } from 'react-router'
import { RequireAuth } from '@/auth/RequireAuth'
import { AppShell } from '@/components/layout/AppShell'
import { LiveSortProvider } from '@/live/LiveSortProvider'
import { LoginPage } from '@/pages/auth/LoginPage'
import { SetupPage } from '@/pages/auth/SetupPage'
import { BookmarksPage, FilesPage, InboxPage, NotesPage } from '@/pages/CollectionPages'
import { OverviewPage } from '@/pages/overview/OverviewPage'
import { RemindersPage } from '@/pages/RemindersPage'
import { SearchPage } from '@/pages/SearchPage'
import { SecretsPage } from '@/pages/SecretsPage'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { TodosPage } from '@/pages/TodosPage'

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="setup" element={<SetupPage />} />
      <Route
        element={
          <RequireAuth>
            <LiveSortProvider>
              <AppShell />
            </LiveSortProvider>
          </RequireAuth>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="notes" element={<NotesPage />} />
        <Route path="bookmarks" element={<BookmarksPage />} />
        <Route path="todos" element={<TodosPage />} />
        <Route path="reminders" element={<RemindersPage />} />
        <Route path="secrets" element={<SecretsPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
