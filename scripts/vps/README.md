# Scripts del VPS

Se copian a `/root` en el servidor y se programan en cron:

```bash
cp agente-watchdog.sh agente-backup.sh /root/ && chmod +x /root/agente-*.sh
(crontab -l; echo "* * * * * /root/agente-watchdog.sh >> /var/log/agente-watchdog.log 2>&1"; \
            echo "30 3 * * * /root/agente-backup.sh >> /var/log/agente-backup.log 2>&1") | crontab -
```

- `agente-watchdog.sh`: cada minuto revisa `http://localhost:4100/login.html`; si no responde reinicia `whatsapp-broadcast`
  con pm2 y avisa por Telegram (token y chat se leen de `agente_config`). Avisa si el disco supera el 90 %.
- `agente-backup.sh`: copia consistente diaria de `data.db` (`VACUUM INTO`) a `/root/backups-db`, 7 días.
