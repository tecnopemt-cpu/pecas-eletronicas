// Teste das regras do Firestore no emulador oficial (roda no GitHub Actions: "Testar regras do banco").
// Simula cada tipo de pessoa (master, administrador, funcionário, pendente, bloqueado, conta antiga,
// visitante do link de assinatura, rotina de backup, estranho) e confere o que cada um consegue fazer.
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';

const DOM = 'acesso.controle-pecas.app';
// o Firebase deixa o e-mail em minúsculas; a ligação com a ficha é pelo uid (contas/<uid> + authUid)
const em = (id, v) => `f-${id}-v${v}@${DOM}`.toLowerCase();
const uid = (id, v) => `uid-${id}-${v}`;
const env = await initializeTestEnvironment({
  projectId: 'demo-controle-pecas',
  firestore: { rules: fs.readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 }
});
const permEditar = { dashboard: 'editar', lotes: 'editar', catalogo: 'editar', clientes: 'editar', orcamentos: 'editar', comissoes: 'editar', funcionarios: 'editar' };
const permFunc = { ...permEditar, funcionarios: 'sem_acesso' };
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  const set = (p, d) => db.doc(p).set(d);
  const ficha = async (id, dados, versao = 1) => {
    await set('funcionarios/' + id, { ...dados, authEmail: em(id, versao), authUid: uid(id, versao) });
    for (let v = 1; v <= versao; v++) await set('contas/' + uid(id, v), { funcionarioId: id, email: em(id, v) });
  };
  await ficha('WAL', { nome: 'Walter', perfil: 'master', status: 'ativo', login: 'walter' });
  await ficha('RAI', { nome: 'Raiany', perfil: 'administrador', status: 'ativo', login: 'raiany', permissoes: permEditar });
  await ficha('FUN', { nome: 'Fábio', perfil: 'funcionario', status: 'ativo', login: 'fabio', permissoes: permFunc });
  await ficha('FU2', { nome: 'Fernanda', perfil: 'funcionario', status: 'ativo', login: 'fe', permissoes: permFunc }, 2);
  await ficha('LEG', { nome: 'Legado', ativo: true, login: 'leg' });
  await ficha('PEN', { nome: 'Pedro', perfil: 'funcionario', status: 'pendente', login: 'pedro', permissoes: {} });
  await ficha('BLO', { nome: 'Bruno', perfil: 'funcionario', status: 'bloqueado', login: 'bruno' });
  await set('contas/uid-intruso', { funcionarioId: 'WAL', email: 'intruso@gmail.com' });
  await set('loginsPublicos/walter', { email: em('WAL', 1) });
  await set('loginsPublicos/fe', { email: em('FU2', 2) });
  await set('seguranca/backup', { uid: 'uid-backup', email: `backup-x@${DOM}` });
  await set('clientes/C1', { razaoSocial: 'Cliente' });
  await set('lotes/L1', { numero: 1, codigoAssinaturaEntrada: '1234', status: 'Em análise' });
  await set('lotes/L2', { numero: 2, codigoAssinaturaEntrada: '1234', assinaturaEntrada: { nome: 'Já assinou' } });
  await set('orcamentos/O1', { numero: 1, codigoAssinaturaTeste: '5555', historico: [{ texto: 'criado' }], status: 'Teste' });
  await set('midias/M1', { dados: 'data:image/png;base64,AAA', usos: [] });
  await set('config/cache', { geracao: 1 });
});
const conta = (id, versao = 1) => env.authenticatedContext(uid(id, versao), { email: em(id, versao), firebase: { sign_in_provider: 'password' } }).firestore();
const como = {
  estranho: env.unauthenticatedContext().firestore(),
  cadastrouSozinho: env.authenticatedContext('uid-x', { email: 'qualquer@gmail.com', firebase: { sign_in_provider: 'password' } }).firestore(),
  semFicha: conta('NAOEXISTE'),
  intruso: env.authenticatedContext('uid-intruso', { email: 'intruso@gmail.com', firebase: { sign_in_provider: 'password' } }).firestore(),
  master: conta('WAL'), admin: conta('RAI'), func: conta('FUN'), legado: conta('LEG'),
  contaAntiga: conta('FU2', 1), contaAtual: conta('FU2', 2),
  pendente: conta('PEN'), bloqueado: conta('BLO'), novo: conta('NOVO'),
  visitante: env.authenticatedContext('uid-anon', { firebase: { sign_in_provider: 'anonymous' } }).firestore(),
  backup: env.authenticatedContext('uid-backup', { email: `backup-x@${DOM}`, firebase: { sign_in_provider: 'password' } }).firestore(),
  backupFalso: env.authenticatedContext('uid-outro', { email: `backup-x@${DOM}`, firebase: { sign_in_provider: 'password' } }).firestore()
};
const fbCompat = (await import('firebase/compat/app')).default;
await import('firebase/compat/firestore');
const FV = fbCompat.firestore.FieldValue;
let ok = 0, falhas = 0;
async function caso(nome, esperado, fn) {
  try { await (esperado ? assertSucceeds(fn()) : assertFails(fn())); ok++; console.log('OK     ' + nome); }
  catch (e) { falhas++; console.log('FALHOU ' + nome + ' — ' + (e.message || e).split('\n')[0]); console.log(`::error::Regra: ${nome}`); }
}
const SIM = true, NAO = false;
// estranhos
await caso('estranho não lê clientes', NAO, () => como.estranho.doc('clientes/C1').get());
await caso('estranho não lê funcionários', NAO, () => como.estranho.doc('funcionarios/WAL').get());
await caso('estranho não grava orçamentos', NAO, () => como.estranho.doc('orcamentos/X').set({ a: 1 }));
await caso('estranho lê o índice de um login (para entrar)', SIM, () => como.estranho.doc('loginsPublicos/walter').get());
await caso('estranho não lista o índice de logins', NAO, () => como.estranho.collection('loginsPublicos').get());
await caso('conta qualquer criada por fora (gmail) não lê nada', NAO, () => como.cadastrouSozinho.doc('clientes/C1').get());
await caso('conta interna sem ficha não lê nada', NAO, () => como.semFicha.doc('clientes/C1').get());
await caso('conta que se "liga" à ficha do master sem ser a conta dela NÃO lê nada', NAO, () => como.intruso.doc('clientes/C1').get());
await caso('estranho NÃO cria ligação de conta para outra pessoa', NAO, () => como.semFicha.doc('contas/uid-outra').set({ funcionarioId: 'WAL' }));
await caso('funcionário lê a própria ligação de conta', SIM, () => como.func.doc('contas/' + uid('FUN', 1)).get());
await caso('funcionário NÃO lê a ligação de outra conta', NAO, () => como.func.doc('contas/' + uid('WAL', 1)).get());
// funcionário ativo
await caso('funcionário lê clientes', SIM, () => como.func.doc('clientes/C1').get());
await caso('funcionário lista orçamentos', SIM, () => como.func.collection('orcamentos').get());
await caso('funcionário grava orçamento', SIM, () => como.func.doc('orcamentos/N1').set({ numero: 9 }));
await caso('funcionário lê a Equipe', SIM, () => como.func.collection('funcionarios').get());
await caso('funcionário edita os próprios dados pessoais', SIM, () => como.func.doc('funcionarios/FUN').update({ telefone: '11999', atualizadoEm: new Date() }));
await caso('funcionário NÃO se promove a master', NAO, () => como.func.doc('funcionarios/FUN').update({ perfil: 'master' }));
await caso('funcionário NÃO muda as próprias permissões', NAO, () => como.func.doc('funcionarios/FUN').update({ permissoes: permEditar }));
await caso('funcionário NÃO muda o próprio % de comissão', NAO, () => como.func.doc('funcionarios/FUN').update({ percentualComissao: 50 }));
await caso('funcionário NÃO edita a ficha de outro', NAO, () => como.func.doc('funcionarios/FU2').update({ telefone: '1' }));
await caso('funcionário NÃO lê a configuração de segurança', NAO, () => como.func.doc('seguranca/backup').get());
await caso('funcionário NÃO troca o índice de login de outro', NAO, () => como.func.doc('loginsPublicos/walter').set({ email: em('FUN', 1) }));
await caso('conta antiga (sem permissões configuradas) mantém acesso', SIM, () => como.legado.collection('clientes').get());
// senha redefinida: a conta anterior perde o acesso
await caso('conta da senha antiga (v1) não lê mais', NAO, () => como.contaAntiga.doc('clientes/C1').get());
await caso('conta atual (v2) lê', SIM, () => como.contaAtual.doc('clientes/C1').get());
await caso('conta da senha antiga vê só a própria ficha (para o sistema avisar)', SIM, () => como.contaAntiga.doc('funcionarios/FU2').get());
await caso('conta da senha antiga NÃO lê a ficha de outro', NAO, () => como.contaAntiga.doc('funcionarios/WAL').get());
// pendente / bloqueado
await caso('pendente vê a própria ficha', SIM, () => como.pendente.doc('funcionarios/PEN').get());
await caso('pendente NÃO lê clientes', NAO, () => como.pendente.doc('clientes/C1').get());
await caso('pendente NÃO lê a ficha de outro', NAO, () => como.pendente.doc('funcionarios/WAL').get());
await caso('pendente NÃO se aprova', NAO, () => como.pendente.doc('funcionarios/PEN').update({ status: 'ativo' }));
await caso('bloqueado NÃO lê nada', NAO, () => como.bloqueado.doc('clientes/C1').get());
// administrador e master
await caso('administrador edita funcionário comum', SIM, () => como.admin.doc('funcionarios/FUN').update({ status: 'bloqueado' }));
await caso('administrador NÃO edita o master', NAO, () => como.admin.doc('funcionarios/WAL').update({ nome: 'x' }));
await caso('administrador NÃO promove ninguém a administrador', NAO, () => como.admin.doc('funcionarios/FU2').update({ perfil: 'administrador' }));
await caso('administrador NÃO lê a configuração de segurança', NAO, () => como.admin.doc('seguranca/backup').get());
await caso('administrador redefine o índice de login de um funcionário', SIM, () => como.admin.doc('loginsPublicos/fe').set({ email: em('FU2', 3) }));
await caso('administrador liga a conta nova de um funcionário', SIM, () => como.admin.doc('contas/uid-FU2-3').set({ funcionarioId: 'FU2', email: em('FU2', 3) }));
await caso('master promove a administrador', SIM, () => como.master.doc('funcionarios/FU2').update({ perfil: 'administrador' }));
await caso('master lê/grava a configuração de segurança', SIM, () => como.master.doc('seguranca/backup').get());
await caso('administrador cria funcionário comum', SIM, () => como.admin.doc('funcionarios/NF1').set({ nome: 'Novo', perfil: 'funcionario', status: 'ativo' }));
await caso('administrador NÃO cria um master', NAO, () => como.admin.doc('funcionarios/NF2').set({ nome: 'Novo', perfil: 'master', status: 'ativo' }));
// cadastro pelo próprio funcionário
const semAcesso = Object.fromEntries(Object.keys(permFunc).map(k => [k, 'sem_acesso']));
const fichaNova = { nome: 'Novo', perfil: 'funcionario', status: 'pendente', authEmail: em('NOVO', 1), authUid: uid('NOVO', 1), permissoes: semAcesso };
const cadastro = (alvo, ficha, extras = b => b) => () => { const b = como.novo.batch(); b.set(como.novo.doc('contas/' + uid('NOVO', 1)), { funcionarioId: alvo, email: em('NOVO', 1) }); b.set(como.novo.doc('funcionarios/' + alvo), ficha); extras(b); return b.commit(); };
await caso('cadastro: confere CPF já cadastrado (antes de ter ficha)', SIM, () => como.novo.doc('cpfs/cpf_x').get());
await caso('cadastro: NÃO nasce ativo', NAO, cadastro('NOVO', { ...fichaNova, status: 'ativo' }));
await caso('cadastro: NÃO nasce com permissões', NAO, cadastro('NOVO', { ...fichaNova, permissoes: permEditar }));
await caso('cadastro: NÃO nasce master', NAO, cadastro('NOVO', { ...fichaNova, perfil: 'master' }));
await caso('cadastro: NÃO liga a conta a outra pessoa', NAO, cadastro('NOVO', { ...fichaNova, authUid: 'uid-outro' }));
await caso('cadastro: NÃO toma um login já existente', NAO, cadastro('NOVO', fichaNova, b => b.set(como.novo.doc('loginsPublicos/walter'), { email: em('NOVO', 1) })));
await caso('cadastro: NÃO aponta login para outra conta', NAO, cadastro('NOVO', fichaNova, b => b.set(como.novo.doc('loginsPublicos/outro'), { email: em('WAL', 1) })));
await caso('cadastro: cria ligação + ficha pendente + índices de login e CPF (num lote)', SIM, cadastro('NOVO', fichaNova, b => { b.set(como.novo.doc('loginsPublicos/novo'), { email: em('NOVO', 1) }); b.set(como.novo.doc('cpfs/cpf_novo'), { funcionarioId: 'NOVO' }); }));
await caso('cadastro: depois de criado, vê só a própria ficha', SIM, () => como.novo.doc('funcionarios/NOVO').get());
await caso('cadastro: NÃO lê dados do sistema', NAO, () => como.novo.doc('clientes/C1').get());
// visitante do link de assinatura
await caso('visitante abre o documento do link', SIM, () => como.visitante.doc('lotes/L1').get());
await caso('visitante NÃO lista entradas', NAO, () => como.visitante.collection('lotes').get());
await caso('visitante abre o cliente do documento', SIM, () => como.visitante.doc('clientes/C1').get());
await caso('visitante NÃO lista clientes', NAO, () => como.visitante.collection('clientes').get());
await caso('visitante NÃO lê funcionários', NAO, () => como.visitante.doc('funcionarios/WAL').get());
await caso('visitante vê uma foto pelo código', SIM, () => como.visitante.doc('midias/M1').get());
await caso('visitante NÃO lista fotos', NAO, () => como.visitante.collection('midias').get());
await caso('visitante NÃO troca o status da entrada', NAO, () => como.visitante.doc('lotes/L1').update({ status: 'Concluído' }));
await caso('visitante NÃO sobrescreve assinatura existente', NAO, () => como.visitante.doc('lotes/L2').update({ assinaturaEntrada: { nome: 'Outro' }, atualizadoEm: new Date() }));
await caso('visitante grava a assinatura da entrada', SIM, () => como.visitante.doc('lotes/L1').update({ assinaturaEntrada: { nome: 'Cliente' }, atualizadoEm: new Date() }));
await caso('visitante NÃO apaga o histórico do orçamento', NAO, () => como.visitante.doc('orcamentos/O1').update({ assinaturaTeste: { nome: 'C' }, historico: [{ texto: 'só isso' }] }));
await caso('visitante grava a assinatura do teste + 1 registro no histórico', SIM, () => como.visitante.doc('orcamentos/O1').update({ assinaturaTeste: { nome: 'C' }, historico: FV.arrayUnion({ texto: 'assinou' }), atualizadoEm: new Date() }));
await caso('visitante grava a imagem da assinatura', SIM, () => como.visitante.doc('midias/M2').set({ dados: 'data:image/png;base64,BBB', usos: [] }));
await caso('visitante NÃO troca o conteúdo de uma foto', NAO, () => como.visitante.doc('midias/M1').set({ dados: 'data:image/png;base64,ZZZ', usos: [] }));
// rotina de backup
await caso('backup lê clientes', SIM, () => como.backup.collection('clientes').get());
await caso('backup lista fotos', SIM, () => como.backup.collection('midias').get());
await caso('backup lê funcionários', SIM, () => como.backup.collection('funcionarios').get());
await caso('backup NÃO grava', NAO, () => como.backup.doc('clientes/C1').update({ razaoSocial: 'x' }));
await caso('outra conta com o mesmo e-mail do backup NÃO lê (vale o uid)', NAO, () => como.backupFalso.collection('clientes').get());
console.log(`\n${ok}/${ok + falhas} verificações das regras ${falhas ? 'com FALHAS' : 'OK'}`);
console.log(falhas ? `::error::Regras do banco: ${falhas} verificação(ões) falharam` : `::notice::Regras do banco: ${ok} verificações OK`);
await env.cleanup();
process.exit(falhas ? 1 : 0);
