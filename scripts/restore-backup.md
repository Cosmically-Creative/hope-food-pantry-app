# Restore a local backup

This puts a saved copy back into the live data directory on this computer. It does not test an offsite copy. Offsite storage is still decision D6.

Stop the app first. A restore while Hope Volunteer is running can leave a half-written database.

1. Stop the container, or stop `npm run dev` if that is what is running.
2. Copy the current data directory aside, including `app.db`, `app.db-wal`, and `app.db-shm`, so you can put it back if the restore is wrong.
3. Pick one file from `data/backups`. Daily copies are named `daily-YYYY-MM-DD.db`. Sunday copies are named `weekly-YYYY-MM-DD.db`. A file named `pre-migrate-` is the database from before a production migration, not the daily schedule.
4. Check the file before replacing the live database:

   ```bash
   sqlite3 data/backups/daily-YYYY-MM-DD.db "PRAGMA integrity_check;"
   ```

   The result should be `ok`.
5. Replace the live database with that file. Remove any `app.db-wal` and `app.db-shm` left from the old live database. The saved copy is one file and does not need those sidecars.

   ```bash
   rm -f data/app.db data/app.db-wal data/app.db-shm
   cp data/backups/daily-YYYY-MM-DD.db data/app.db
   ```

6. While the app is still stopped, revoke sign-in cookies from the restored copy and hold mail that was waiting. Otherwise a restored cookie still signs a coordinator in, and waiting messages are sent after startup.

   ```bash
   sqlite3 data/app.db "DELETE FROM sessions; DELETE FROM login_tokens; UPDATE outbox SET status = 'cancelled', last_error = 'Held after a restore.' WHERE status IN ('pending', 'sending');"
   ```

7. If Docker runs the app, the `node` user inside the image must be able to write the data directory. That user is uid 1000. Do not make the directory writable by everyone.

   ```bash
   sudo chown 1000:1000 data data/app.db
   sudo chmod 750 data
   ```

8. Start the app again. Startup still removes personal details that are past the retention period. Check `/healthz` and a roster before treating the restore as finished.

A backup taken before a cleanup still contains the old names and email addresses. Restoring it brings those details back into the live database.
