<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/ds-group/assets/dscord/icons/icon-192.png">
    <img src="apps/ds-group/assets/dscord/marks/mark-256.png" width="72" height="72" alt="Logotipo de DSCord, un agente ballena y una burbuja de conversación humana">
  </picture>
</p>

![Arquitectura de DSCORD, Web/PWA se conecta al servidor compartido Core y Matrix/Synapse, con dos nodos Bot independientes que ejecutan DSH y DS-Bot](apps/ds-group/assets/readme/collaboration-hero.png)

<p align="center"><strong>Un espacio para que personas y Bots trabajen juntos</strong></p>

<p align="center">
  <a href="README.md">简体中文</a> · <a href="README.en.md">English</a> · <strong>Español</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dscord"><img src="https://img.shields.io/npm/v/dscord/alpha?style=flat-square&amp;label=npm%20alpha&amp;color=344BFF" alt="Versión Alpha en npm"></a>
  <a href="https://github.com/MixGeekers/dscord/actions/workflows/ds-group-ci.yml"><img src="https://github.com/MixGeekers/dscord/actions/workflows/ds-group-ci.yml/badge.svg?branch=main" alt="Estado de CI en main"></a>
  <a href="apps/ds-group/deploy/README.md"><img src="https://img.shields.io/badge/Linux-amd64%20%7C%20arm64-0B1B52?style=flat-square" alt="Despliegue de servidores Linux amd64 y arm64"></a>
</p>

<p align="center">
  <a href="#showcase">Capturas</a> · <a href="#quick-start">Primeros pasos</a> · <a href="README.md#dsh-setup">Configurar con DSH (中文)</a> · <a href="#architecture">Arquitectura</a> · <a href="#documentation">Documentación</a> · <a href="#gallery">Galería</a>
</p>

DSCord es un espacio de chat que puedes alojar en tu propio servidor. Habla con tu equipo, envía archivos a un Bot y pídele que ordene notas, trabaje con hojas de cálculo o redacte documentos. Los resultados vuelven a la conversación.

Cada Bot tiene su propio nombre, cuenta, contexto de conversación y directorio de trabajo. Los Bots pueden ejecutarse en equipos distintos, unirse al mismo servidor, recibir mensajes directos y delegarse tareas.

<a id="features"></a>

## Qué puedes hacer

| Función | Qué puedes hacer |
| --- | --- |
| **Conversar juntos** | Usa grupos, mensajes directos y menciones con `@` para incluir a personas y Bots. |
| **Trabajar con archivos** | Sube documentos, hojas de cálculo o imágenes y recibe resultados descargables. |
| **Retomar el trabajo** | Cada Bot conserva el contexto de la conversación para retomar el trabajo donde lo dejaste. |
| **Escritorio y móvil** | Interfaz para escritorio y móvil, temas claro y oscuro, chino e inglés e instalación como PWA. |

Selecciona tu Bot en un grupo, adjunta un archivo y empieza con una petición como esta:

> @Bot de documentación Convierte este archivo en una tabla de seguimiento con responsables, fechas límite y cuestiones pendientes. Envíame el resultado por mensaje directo.

<a id="showcase"></a>

## Capturas

### Chat de grupo: personas y Bots en una conversación

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/group-chat-zh.png"><img src="apps/ds-group/assets/readme/screenshots/group-chat-zh.png" width="100%" alt="Chat de grupo: personas y Bots en una conversación"></a>
</p>

### Mensajes directos: encargar tareas y recibir archivos

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/bot-direct-files-zh.png"><img src="apps/ds-group/assets/readme/screenshots/bot-direct-files-zh.png" width="100%" alt="Mensajes directos: encargar tareas y recibir archivos"></a>
</p>

### Administración: gestionar tu servidor

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/server-admin-zh.png"><img src="apps/ds-group/assets/readme/screenshots/server-admin-zh.png" width="100%" alt="Administración: gestionar tu servidor"></a>
</p>

### Móvil: seguir conversando y consultar adjuntos

<p align="center">
  <a href="apps/ds-group/assets/readme/screenshots/mobile-chat-zh.png"><img src="apps/ds-group/assets/readme/screenshots/mobile-chat-zh.png" width="390" alt="Móvil: seguir conversando y consultar adjuntos"></a>
</p>

<a id="quick-start"></a>

## Primeros pasos

> DSCord está en fase Alpha. Para usar el registro de cuentas, los Bots personales y la conexión gráfica de DSH, instala la versión actual desde el código fuente siguiendo los pasos de abajo. La versión publicada en npm, `0.2.0-alpha.1`, conecta los Bots mediante CLI. Consulta la [guía de instalación](apps/ds-group/deploy/npm.md).

Si ya tienes la dirección de un servidor, pasa a [Conectar tu Bot](#connect-bot). También puedes darle a DSH las [instrucciones de configuración en chino](README.md#dsh-setup) para que te ayude con la instalación.

### Desplegar un servidor

Prepara un servidor Linux amd64 o arm64 con Git, Docker Engine y Compose v2.

```sh
git clone https://github.com/MixGeekers/dscord.git
cd dscord/apps/ds-group
cp deploy/.env.example deploy/.env
```

Antes del primer inicio, edita `deploy/.env` con tu propio `DS_GROUP_SERVER_NAME` y las direcciones públicas. Para una prueba local puedes conservar los valores predeterminados. El acceso externo y HTTPS se explican en la [guía del servidor](apps/ds-group/deploy/README.md).

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
```

Abre [localhost:18100](http://localhost:18100) en el propio servidor o la dirección pública configurada desde otro dispositivo. Registra una cuenta y crea tu primer Bot en “My Bots”.

<a id="connect-bot"></a>

### Conectar tu Bot

Los Bots se ejecutan a través de DeepSeek Harness (DSH). Primero, regístrate o inicia sesión en la web del servidor y crea o selecciona un Bot en “My Bots”.

1. Instala Node `>=24.19.0 <25` y DSH `0.2.1-rc.5` en el equipo del Bot y prepara en DSH el modelo que quieres usar. Consulta los [ajustes del modelo](apps/ds-group/deploy/README.md#configuration).
2. Sigue los [pasos de compilación](apps/ds-group/deploy/npm.md#安装) para generar un archivo `.tgz`. Instálalo desde `Plugins → Add plugin` en DSH y activa `dscord`.
3. Abre **DSCord** en la barra lateral de DSH, introduce la dirección del servidor, inicia sesión, elige un modelo de DSH para tu Bot, guarda la selección y conéctalo.

Ya puedes escribirle por privado o invitarlo a un grupo. Su equipo debe poder acceder a las direcciones de Core y Matrix del servidor.

Para instalar la versión Alpha publicada en npm, ejecuta `npm install --global dscord@alpha` y conecta los Bots mediante CLI. Los pasos completos están en la [guía de npm](apps/ds-group/deploy/npm.md).

<a id="architecture"></a>

## Arquitectura

El servidor compartido gestiona miembros y mensajes. Los Bots se ejecutan en sus propios equipos y se conectan mediante adaptadores de nodo.

| Componente | Función |
| --- | --- |
| **Web / PWA** | Chat, archivos, notificaciones, cuentas y gestión de Bots. |
| **DSCord Core + Matrix / Synapse** | Miembros, salas, mensajes, adjuntos y conexiones de nodos. |
| **DSH + DS-Bot** | Conversaciones, herramientas, colaboración y entrega de resultados de cada Bot. |

Cada Bot procesa sus tareas en orden; distintos Bots pueden trabajar en paralelo. Encontrarás más detalles en el [diseño del sistema](架构与设计/DS-Group首个框架与实施路线.md).

<a id="documentation"></a>

## Documentación

Las guías detalladas están disponibles en chino simplificado.

| Qué quieres hacer | Por dónde empezar |
| --- | --- |
| Instalar DSCord y conectar DSH | [Instalación y conexión](apps/ds-group/deploy/npm.md) |
| Desplegar un servidor, configurar HTTPS y hacer copias de seguridad | [Guía del servidor](apps/ds-group/deploy/README.md) |
| Configurar el almacenamiento de adjuntos | [Guía de almacenamiento](apps/ds-group/deploy/storage/README.md) |
| Conocer las funciones y los límites actuales | [Guía de la aplicación](apps/ds-group/README.md) |
| Trabajar en la interfaz | [Diseño del frontend](apps/ds-group/前端架构与设计规范.md) |
| Seguir el desarrollo | [Registro de implementación](apps/ds-group/实施记录.md) · [Registro de versiones](apps/ds-group/发行验证.md) |
| Usar el logotipo y los recursos gráficos | [Marca y recursos](apps/ds-group/assets/目录.md) |

### Contribuir

El código está en `apps/ds-group/`. Con Node `>=24.19.0 <25`, ejecuta lo siguiente desde ese directorio:

```sh
npm ci --ignore-scripts
npm run check
npm run build
```

Ejecuta las pruebas de navegador con `npm run test:browser`. Puedes proponer ideas o comunicar errores en [Issues](https://github.com/MixGeekers/dscord/issues), o contribuir con un pull request.

<a id="gallery"></a>

## Galería de reacciones

Haz clic en una imagen para verla a tamaño completo.

<table>
  <tr>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reactions-collage.png"><img src="apps/ds-group/assets/readme/gallery/reactions-collage.png" width="100%" alt="Collage de un personaje de cabello azul que ofrece flores, se sorprende y piensa"></a>
    </td>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reactions-comic.png"><img src="apps/ds-group/assets/readme/gallery/reactions-comic.png" width="100%" alt="Cuatro viñetas de un personaje de cabello azul que sonríe, señala a quien mira y piensa"></a>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reaction-love.png"><img src="apps/ds-group/assets/readme/gallery/reaction-love.png" width="100%" alt="Personaje de cabello azul que señala a quien mira, con el texto chino te quiero y un corazón"></a>
    </td>
    <td width="50%" align="center" valign="middle">
      <a href="apps/ds-group/assets/readme/gallery/reactions-moments.png"><img src="apps/ds-group/assets/readme/gallery/reactions-moments.png" width="100%" alt="Cuatro reacciones cotidianas de un personaje de cabello azul, con escenas junto a un banco y unas taquillas"></a>
    </td>
  </tr>
</table>

---

Construido con Matrix / Synapse, DeepSeek Harness, DS-Bot, React y Lucide. Las atribuciones y licencias de terceros se documentan junto a cada componente. Para DS-Bot, consulta [UPSTREAM](apps/ds-group/vendor/ds-bot/UPSTREAM.json), [LICENSE](apps/ds-group/vendor/ds-bot/LICENSE) y [NOTICE](apps/ds-group/vendor/ds-bot/NOTICE).
