'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {installerText}=require('./installer-i18n');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');
const installer=read('install.sh');
const language=read('scripts/installer-language.sh');
const block=text=>text.slice(text.indexOf('# BEGIN INSTALLER LANGUAGE'),text.indexOf('# END INSTALLER LANGUAGE')+'# END INSTALLER LANGUAGE'.length);
const bash=process.env.NAIT_AWG_TEST_BASH||'bash';
const probe=spawnSync(bash,['--version'],{encoding:'utf8'});
function run(script,env={},input=''){
 return spawnSync(bash,['--noprofile','--norc','-c',script],{encoding:'utf8',input,env:{...process.env,NAIT_AWG_LANG:'',...env}});
}
function requireBash(t){if(probe.error){t.skip('Bash is unavailable; set NAIT_AWG_TEST_BASH to test shell behavior.');return false;}return true;}
function pairs(text){return [...text.matchAll(/installer_text (?:'([^'\n]*)' '([^'\n]*)'|"([^"\n]*)" "([^"\n]*)")/g)].map(m=>({ru:m[1]??m[3],en:m[2]??m[4],call:m[0]}));}

test('piped bootstrap embeds the same language selector as the source-only helper',()=>{
 assert.equal(block(installer),block(language));
 assert(installer.indexOf('installer_language_init || exit $?')<installer.indexOf('requested_action='));
 assert.match(language,/Выберите язык \/ Select language/);
 assert.match(language,/1\) RU/);assert.match(language,/2\) EN/);
 assert.match(language,/language_choice <\/dev\/tty/);
 assert.match(installer,/source_dir\/scripts\/installer-language\.sh/);
 assert.match(installer,/source_dir\/scripts\/installer-i18n\.js/);
});

test('project messages have English text with matching printf format arguments',()=>{
 const messages=['install.sh','scripts/installer-output.sh','scripts/install-fresh-awg.sh','scripts/load-awg-image.sh'].flatMap(file=>pairs(read(file)));
 assert(messages.length>170);
 for(const message of messages){
  assert.doesNotMatch(message.en,/[А-Яа-яЁё]/,message.ru);
  assert.deepEqual(message.en.match(/%[sd]/g)||[],message.ru.match(/%[sd]/g)||[],message.ru);
  assert.equal(message.en.includes('\\n'),message.ru.includes('\\n'),message.ru);
 }
});

test('all installer shell files pass Bash syntax checks',t=>{
 if(!requireBash(t))return;
 for(const file of ['install.sh','scripts/installer-language.sh','scripts/installer-output.sh','scripts/install-fresh-awg.sh','scripts/load-awg-image.sh']){
  const result=spawnSync(bash,['--noprofile','--norc','-n'],{input:read(file),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
 }
});

test('interactive language choice retries invalid answers and exports the result to children',t=>{
 if(!requireBash(t))return;
 const interactive=block(language).replace('if ! { : </dev/tty; } 2>/dev/null; then','if false; then').replace('</dev/tty','');
 for(const [answer,selected]of [['1\n','ru'],['2\n','en'],['bad\n2\n','en']]){
  const result=run(interactive+'\ninstaller_language_init || exit $?\nprintf "selected=%s\\n" "$NAIT_AWG_LANG"\n"$BASH" --noprofile --norc -c \'printf "child=%s\\n" "$NAIT_AWG_LANG"\'\n',{},answer);
  assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/Выберите язык \/ Select language/);
  assert.equal(result.stdout,`selected=${selected}\nchild=${selected}\n`);
  if(answer.startsWith('bad'))assert.match(result.stderr,/Choose 1 or 2/);
 }
 const cancelled=run(interactive+'\ninstaller_language_init || exit $?');assert.equal(cancelled.status,1);assert.match(cancelled.stderr,/Language selection cancelled/);
});

test('explicit language skips prompts, invalid values fail, and no-terminal fallback preserves stdin',t=>{
 if(!requireBash(t))return;
 for(const lang of ['ru','en']){
  const result=run(block(language)+'\ninstaller_language_init || exit $?\nprintf "%s" "$NAIT_AWG_LANG"',{NAIT_AWG_LANG:lang});
  assert.equal(result.status,0);assert.equal(result.stdout,lang);assert.equal(result.stderr,'');
 }
 const invalid=run(block(language)+'\ninstaller_language_init || exit $?',{NAIT_AWG_LANG:'invalid'});assert.equal(invalid.status,2);
 const unattended=run(block(language).replace('if ! { : </dev/tty; } 2>/dev/null; then','if true; then')+'\ninstaller_language_init || exit $?\nprintf "%s " "$NAIT_AWG_LANG"\nIFS= read -r remaining; printf "%s" "$remaining"',{},'piped-script-content\n');
 assert.equal(unattended.status,0);assert.equal(unattended.stdout,'ru piped-script-content');assert.equal(unattended.stderr,'');
});

test('all English shell messages render in Bash without leftover Russian or interpolation errors',t=>{
 if(!requireBash(t))return;
 const values='update_backup=/tmp/test; PANEL_UNIT=nait-awg-selfhost.service; RECEIVER_UNIT=nait-awg-receiver-selfhost.service; panel_address=https://example.test:51633/; admin_password=test-password; INSTALL_DIR=/opt/naitlab/nait_awg; detected_endpoint=203.0.113.1; suggested_panel_port=443; panel_port=51633; suggested_awg_port=55424; awg_container=amnezia-awg2; awg_subnet=10.8.1.0/24; awg_port=55424; target=/tmp/test; unit=test.service; cmd=curl; port=55424; STATE_DIR=/opt/naitlab/nait_awg_runtime; CONTAINER=amnezia-awg2; status=1; AWG_TOOLS_VERSION=v3.1; tools_name=; tools_version=; command_name=docker;';
 const messages=['install.sh','scripts/installer-output.sh','scripts/install-fresh-awg.sh','scripts/load-awg-image.sh'].flatMap(file=>pairs(read(file)));
 let output='';
 for(let offset=0;offset<messages.length;offset+=16){
  const result=run(block(language)+'\n'+values+'\n'+messages.slice(offset,offset+16).map(m=>'printf "%s\\n" "$('+m.call+')"').join('\n'),{NAIT_AWG_LANG:'en'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');assert.doesNotMatch(result.stdout,/[А-Яа-яЁё]/);
  output+=result.stdout;
 }
 assert.match(output,/Nait-AWG is available at: https:\/\/example\.test:51633\//);
 assert.match(output,/received empty response/);
});

test('Node helper localizes diagnostics only; machine stdout contracts stay intact',()=>{
 const original=process.env.NAIT_AWG_LANG;
 try{process.env.NAIT_AWG_LANG='en';assert.equal(installerText('Ошибка','Error'),'Error');process.env.NAIT_AWG_LANG='ru';assert.equal(installerText('Ошибка','Error'),'Ошибка');}
 finally{if(original===undefined)delete process.env.NAIT_AWG_LANG;else process.env.NAIT_AWG_LANG=original;}
 const preflight=read('scripts/selfhost-preflight.js');
 assert.match(preflight,/process\.stdout\.write\(`\$\{result\.container\}\\t\$\{result\.subnet\}\\t\$\{result\.startedAt\}\\n`\)/);
 const credentials=read('scripts/admin-credentials.js');assert.match(credentials,/process\.stdout\.write\(generatePassword\(\)\)/);
 assert.match(credentials,/process\.stdout\.write\(resetCredentials\(directory\)\.password\)/);
 const access=read('scripts/panel-access.js');assert.match(access,/process\.stdout\.write\(String\(normalizePanelPort\(args\[0\]\)\)\)/);
});

test('action menu follows the selected language and keeps the same four actions',t=>{
 if(!requireBash(t))return;
 const start=installer.indexOf('  requested_action="${NAIT_AWG_ACTION:-}"');
 const end=installer.indexOf('\n  if [[ "$requested_action" == install',start);
 const menu=installer.slice(start,end).replace('[[ -r /dev/tty ]]','true').replace('</dev/tty','');
 for(const [lang,heading]of [['ru','Выберите действие:'],['en','Choose an action:']]){
  for(const [choice,action]of [['1','install'],['2','full'],['3','update'],['4','reset-auth']]){
   const result=run(block(language)+'\ninstaller_language_init || exit $?\n'+menu+'\nprintf "%s" "$requested_action"',{NAIT_AWG_LANG:lang,NAIT_AWG_ACTION:''},choice+'\n');
   assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,action);assert(result.stderr.includes(heading));
   if(lang==='en')assert.doesNotMatch(result.stderr,/[А-Яа-яЁё]/);
  }
 }
});

test('localized logging keeps noisy output off the screen and preserves failure exit codes',t=>{
 if(!requireBash(t))return;
 const source=read('scripts/installer-output.sh');
 const functions=source.slice(source.indexOf('installer_log_init()'));
 const setup=block(language)+'\n'+functions+'\ninstaller_log_init() { return 0; }; NAIT_AWG_INSTALL_LOG=/dev/null;\n';
 const success=run(setup+'run_logged "$(installer_text \'Устанавливаем пакеты...\' \'Installing packages...\')" printf "%s\\n" "NOISY-COMMAND-OUTPUT"',{NAIT_AWG_LANG:'en'});
 assert.equal(success.status,0);assert.equal(success.stdout,'');assert.equal(success.stderr,'Installing packages...\n');
 const failed=run(setup+'run_logged "$(installer_text \'Проверяем пакеты...\' \'Checking packages...\')" "$BASH" --noprofile --norc -c "exit 7"',{NAIT_AWG_LANG:'en'});
 assert.equal(failed.status,7);assert.equal(failed.stdout,'');assert.match(failed.stderr,/Stage failed: Checking packages\.\.\. \(exit code 7\)/);assert.doesNotMatch(failed.stderr,/[А-Яа-яЁё]/);
});
