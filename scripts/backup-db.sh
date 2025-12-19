#!/bin/bash
# Backup PostgreSQL to Azure Blob Storage

set -e

BACKUP_DIR="/home/azureuser/db-backups"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="opensocial_backup_$DATE.sql"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Create backup
echo "Creating backup: $BACKUP_FILE"
sudo -u postgres pg_dump opensocial > "$BACKUP_DIR/$BACKUP_FILE"
gzip "$BACKUP_DIR/$BACKUP_FILE"

# Upload to Azure Blob Storage (if configured)
if [ ! -z "$AZURE_STORAGE_CONNECTION_STRING" ]; then
    echo "Uploading to Azure Blob Storage..."
    az storage blob upload \
        --connection-string "$AZURE_STORAGE_CONNECTION_STRING" \
        --container-name db-backups \
        --name "$BACKUP_FILE.gz" \
        --file "$BACKUP_DIR/$BACKUP_FILE.gz" 2>/dev/null || echo "Azure upload skipped (not configured)"
else
    echo "Azure Storage not configured, keeping local backup only"
fi

# Keep only last 7 days locally
find "$BACKUP_DIR" -name "*.gz" -mtime +7 -delete

echo "Backup completed: $BACKUP_FILE.gz"