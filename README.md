# MODELAGEM ANTUNES — espaço 3D A3

Espaço compartilhado para receber projetos `.blend` e modelos `.glb`, com até quatro visualizadores 3D independentes. A biblioteca é comum a todos os navegadores conectados: arquivos novos e versões substituídas são anunciados por WebSocket e aparecem em tempo real.

## Iniciar no Windows

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app:app --reload
```

Abra `http://127.0.0.1:8000`. O primeiro uso precisa de internet para instalar as dependências e carregar o Three.js e as fontes da interface.

## Enviar ou atualizar modelos

Envie um projeto `.blend` (inclusive comprimido pelo Blender ou backup `.blend1`) ou um modelo `.glb` pelo botão **Enviar arquivo**, arraste-o para o navegador, ou coloque-o na pasta `models/`. Também é possível clicar em **GitHub** e informar o link de um arquivo público `.blend` ou `.glb` (link `github.com/.../blob/...` ou `raw.githubusercontent.com`). O site aceita até 250 MB por arquivo. Um arquivo com o mesmo nome substitui a versão anterior e os participantes conectados recebem a atualização.

Links importados do GitHub ficam monitorados no servidor. O arquivo remoto é conferido a cada 5 segundos; quando muda, a cópia local e os visores conectados são atualizados automaticamente. Se alguém enviar manualmente um arquivo com o mesmo nome, o vínculo com o GitHub é removido.

Quando o Blender está instalado no servidor, cada `.blend` recebido é convertido automaticamente em uma prévia `.glb`, mantendo o arquivo original na biblioteca. Se estiver usando outro servidor sem Blender, envie também uma versão `.glb` exportada pelo Blender.

Cada painel tem seleção e câmera próprias. Escolha um arquivo no menu e clique em **Carregar** para exibi-lo; o botão de tela cheia expande aquele visualizador. Clicar em um item da biblioteca seleciona-o no primeiro painel vazio. Os quatro painéis podem exibir modelos diferentes.

## Publicar com HTTPS

O GitHub guarda o código; o Render executa o Docker, Python e Blender. Crie o repositório `modelagem-antunes` no GitHub e envie estes arquivos, depois no Render escolha **New > Blueprint** e conecte esse repositório. O Render usa `render.yaml`, publica o serviço em uma URL `https://modelagem-antunes.onrender.com` (se o nome estiver disponível) e faz novo deploy quando houver atualizações no GitHub.

O Blueprint reserva um disco persistente de 1 GB e um plano de 1 CPU/2 GB para o Blender. Esses recursos são pagos no Render. O `.dockerignore` exclui `models/` e `data/`; depois que o deploy estiver no ar, envie novamente o `.blend` pelo site para ele ficar no disco online.

O site ficará **sem senha**, como solicitado. Qualquer pessoa com a URL poderá enviar, substituir e excluir arquivos. O repositório pode ser privado, mas isso não torna o site privado.

## Acesso dos amigos

Por padrão, o servidor só aceita conexões do próprio computador. Para amigos na mesma rede Wi-Fi, inicie com `python -m uvicorn app:app --host 0.0.0.0 --port 8000` e compartilhe o endereço IP local do computador com a porta `8000`, por exemplo `http://192.168.0.10:8000`. O firewall do Windows pode pedir autorização para conexões na rede privada.

Para acesso fora da rede local, use a publicação HTTPS acima. Links GitHub e sincronização ao vivo continuam funcionando no serviço hospedado.