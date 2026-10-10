// Integration fixtures must perform real byte transfers so bandwidth and quota
// tests cannot be bypassed by APFS reflink copies.
if (process.platform === 'darwin') process.env.RCLONE_LOCAL_NO_CLONE = 'true';
