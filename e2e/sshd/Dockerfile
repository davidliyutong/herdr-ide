# The SSH machine of the end-to-end tests (e2e/harness/sshd.ts): OpenSSH on
# Linux, one user `e2e` who signs in with a key only, bash as login shell.
# Each container gets a host key of its own at start and the test's
# throwaway public key (E2E_AUTHORIZED_KEY); the harness publishes port 22
# on 127.0.0.1 only. The machine build the hub uploads (for musl) and the
# fake programs the harness copies in are Bun's executables, whose runtime
# needs libstdc++ and libgcc; nothing else but a POSIX userland, and Xvfb
# for the program windows (feature 14), which the node uses as installed.
FROM alpine:3.22
RUN apk add --no-cache bash openssh-server xvfb libstdc++ libgcc \
  && adduser -D -s /bin/bash e2e \
  && sed -i 's/^e2e:!/e2e:*/' /etc/shadow \
  && rm -f /etc/ssh/ssh_host_* \
  && printf "PS1='\$ '\n" >/home/e2e/.bashrc \
  && printf '. ~/.bashrc\n' >/home/e2e/.bash_profile \
  && chown e2e:e2e /home/e2e/.bashrc /home/e2e/.bash_profile
COPY sshd_config /etc/ssh/sshd_config
COPY start.sh /usr/local/bin/e2e-start
CMD ["/usr/local/bin/e2e-start"]
