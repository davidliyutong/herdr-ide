#!/bin/sh
# Writes a fresh host key and the test's public key, starts sshd as a
# daemon and waits. The tests take the machine offline by ending every sshd
# process and bring it back by starting sshd again (docker exec), so the
# container and the terminal core inside it live on in between; tini
# (docker run --init) reaps the processes that leave.
set -eu
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
install -d -o e2e -g e2e -m 700 /home/e2e/.ssh
printf '%s\n' "${E2E_AUTHORIZED_KEY:?}" >/home/e2e/.ssh/authorized_keys
chown e2e:e2e /home/e2e/.ssh/authorized_keys
chmod 600 /home/e2e/.ssh/authorized_keys
/usr/sbin/sshd -E /var/log/sshd.log
touch /run/e2e-ready
exec sleep infinity
