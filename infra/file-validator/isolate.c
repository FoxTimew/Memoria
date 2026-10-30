#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#if defined(__x86_64__)
#define EXPECTED_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define EXPECTED_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported sandbox architecture
#endif

static void fail(void) { fputs("CONVERTER_ISOLATION_UNAVAILABLE\n", stderr); exit(78); }
static void no_network(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, EXPECTED_ARCH, 1, 0),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_STMT(BPF_ALU|BPF_AND|BPF_K, 0x3fffffff),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socket, 2, 0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socketpair, 1, 0),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO | EPERM),
  };
  struct sock_fprog p = {.len=sizeof(filter)/sizeof(filter[0]), .filter=filter};
  if (prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0) || prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&p)) fail();
}
static void allow(int rules, const char *path, uint64_t access) {
  int fd = open(path,O_PATH|O_CLOEXEC);
  if(fd<0) fail();
  struct landlock_path_beneath_attr r = {.allowed_access=access,.parent_fd=fd};
  if(syscall(__NR_landlock_add_rule,rules,LANDLOCK_RULE_PATH_BENEATH,&r,0)) fail();
  close(fd);
}
static void restrict_files(const char *input,const char *output) {
  int abi=syscall(__NR_landlock_create_ruleset,NULL,0,LANDLOCK_CREATE_RULESET_VERSION);
  if(abi<3) fail(); // No silent fallback without truncate/rename confinement.
  const uint64_t read=LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_READ_DIR;
  const uint64_t handled=(1ULL<<15)-1;
  struct landlock_ruleset_attr attr={.handled_access_fs=handled};
  int rules=syscall(__NR_landlock_create_ruleset,&attr,sizeof(attr),0);
  if(rules<0) fail();
  allow(rules,"/usr",read|LANDLOCK_ACCESS_FS_EXECUTE);
  allow(rules,"/lib",read|LANDLOCK_ACCESS_FS_EXECUTE);
#if defined(__x86_64__)
  allow(rules,"/lib64",read|LANDLOCK_ACCESS_FS_EXECUTE);
#endif
  allow(rules,"/validator",read|LANDLOCK_ACCESS_FS_EXECUTE);
  allow(rules,"/etc/ld.so.cache",LANDLOCK_ACCESS_FS_READ_FILE);
  allow(rules,"/proc",read);
  allow(rules,"/sys",read);
  /* Windows bind mounts require a rule at the mount boundary. Admission permits
   * exactly one job and refuses ANY residual entry; never store other data here. */
  (void)input;
  allow(rules,"/exchange",read);
  allow(rules,output,read|LANDLOCK_ACCESS_FS_WRITE_FILE|LANDLOCK_ACCESS_FS_TRUNCATE|
    LANDLOCK_ACCESS_FS_MAKE_REG|LANDLOCK_ACCESS_FS_REMOVE_FILE);
  if(syscall(__NR_landlock_restrict_self,rules,0)) fail();
  close(rules);
  struct sock_filter filter[]={
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
    BPF_STMT(BPF_ALU|BPF_AND|BPF_K,0x3fffffff),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_ptrace,5,0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_process_vm_writev,4,0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_process_vm_readv,3,0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_setsid,2,0),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_setpgid,1,0),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
  };
  struct sock_fprog p={.len=sizeof(filter)/sizeof(filter[0]),.filter=filter};
  if(prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&p)) fail();
}
int main(int argc,char **argv) {
  if(argc<3) fail();
  no_network(); // Applies to the supervisor and every descendant, alongside Docker's default seccomp.
  if(!strcmp(argv[1],"--supervisor")) execvp(argv[2],argv+2);
  else if(argc>=5 && !strcmp(argv[1],"--decode")) {
    restrict_files(argv[2],argv[3]);
    execvp(argv[4],argv+4);
  }
  fail();
}
