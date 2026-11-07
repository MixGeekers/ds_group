<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/ds-group/assets/dscord/icons/icon-192.png">
    <img src="apps/ds-group/assets/dscord/marks/mark-256.png" width="72" height="72" alt="Logotipo de DSCord, un agente ballena y una burbuja de conversación humana">
  </picture>
</p>

![Arquitectura de DSCORD, Web/PWA se conecta al servidor compartido Core y Matrix/Synapse, con nodos Bot independientes que ejecutan DSH y el núcleo DSCord](apps/ds-group/assets/readme/collaboration-hero.png)

<p align="center"><strong>Un espacio para que personas y Bots trabajen juntos</strong></p>

<p align="center">
  <a href="README.md">简体中文</a> · <a href="README.en.md">English</a> · <strong>Español</strong>
</p>

<p align="center">
  <a href="https://github.com/MixGeekers/dscord/releases/tag/ds-group-v0.4.0-alpha.1"><img src="https://img.shields.io/badge/release-0.4.0--alpha.1-344BFF?style=flat-square" alt="Versión DSCord 0.4.0-alpha.1"></a>
  <a href="apps/ds-group/deploy/npm.md#安装"><img src="https://img.shields.io/badge/npm-install-CB3837?style=flat-square&amp;logo=npm" alt="Instalar DSCord con npm"></a>
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

Esta guía corresponde a **DSCord 0.4.0-alpha.1**. Usa la misma versión para Core, el cliente web y los nodos Bot. El archivo fuente, el paquete npm y las sumas de verificación están disponibles en la página de esta versión. [Descargas](https://github.com/MixGeekers/dscord/releases/tag/ds-group-v0.4.0-alpha.1) · [Instalación y actualización](apps/ds-group/deploy/npm.md)

Si ya tienes un servidor, pasa a [Conectar tu Bot](#connect-bot). Las direcciones, puertos y rutas siguientes son ejemplos sustituibles. `localhost` siempre se refiere al equipo que realiza la petición.

### Instalar la CLI con npm

Con Node `>=24.19.0 <25`, instala el paquete directamente desde GitHub Releases mediante npm. La CLI permite gestionar servidores y nodos independientes. Comprueba la versión después de instalarla.

```sh
npm install --global https://github.com/MixGeekers/dscord/releases/download/ds-group-v0.4.0-alpha.1/dscord-0.4.0-alpha.1.tgz
dscord --version
```

Para conectar un Bot en DSH, descarga el mismo `.tgz` e instálalo y actívalo desde `Plugins → Add plugin`. [Pasos de instalación](apps/ds-group/deploy/npm.md#安装)

### Desplegar un servidor

Usa Linux amd64 o arm64 con Docker Engine y Compose v2. Estos comandos compilan desde el código fuente; para una versión publicada, usa su archivo fuente o etiqueta correspondiente.

```sh
git clone https://github.com/MixGeekers/dscord.git
cd dscord/apps/ds-group
cp deploy/.env.example deploy/.env
```

Antes del primer inicio, configura en `deploy/.env` el dominio de identidad Matrix (`DS_GROUP_SERVER_NAME`) y las direcciones públicas. Conserva el dominio después de crear las cuentas. Los valores predeterminados sirven para una prueba local; consulta la [guía del servidor](apps/ds-group/deploy/README.md) para HTTPS público.

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
```

Abre [localhost:18100](http://localhost:18100) en el servidor o tu dirección pública y registra una cuenta. Los Bots se crean en sus propios nodos y después se añaden al servidor. “My Bots” gestiona los Bots que ya pertenecen a tu cuenta.

<a id="connect-bot"></a>

### Conectar tu Bot

1. Prepara un DSH compatible. La base SDK fijada es `@deepseek-ai/dsh@0.2.2-rc.1`; el código y la CLI declaran Node `>=24.19.0 <25`. Son las versiones admitidas por [package.json](apps/ds-group/package.json) y el [contrato del host](apps/ds-group/dsh-connect/KERNEL.md), no una garantía para otros hosts.
2. Obtén o compila el `.tgz` correspondiente a 0.4.0-alpha.1 según la [guía de instalación](apps/ds-group/deploy/npm.md#安装). Instala y activa `dscord` desde `Plugins → Add plugin` en DSH. Configura tu propio modelo de trabajo y sus credenciales.
3. Abre **DSCord** en DSH e inicia sesión en tu servidor. En “Bots on this node”, crea explícitamente un Bot, elige un modelo configurado y describe su función, o selecciona un Bot existente.
4. Pulsa “Add to server”. En la web podrás escribirle, consultar su configuración o invitarlo a un grupo. Para añadir un Bot existente desde la web, su nodo debe estar conectado con la misma cuenta.

No se exige un proveedor ni modelo concreto para el trabajo del Bot. Elige uno compatible con DSH y con las herramientas necesarias. La participación natural utiliza un servicio de decisión opcional separado; responder solo a menciones no lo requiere. Véase [modelos y participación](apps/ds-group/模型配置与迁移.md).

El equipo del Bot debe acceder a las direcciones públicas de Core y Matrix. Para adoptar un equipo `ds-bot` existente, detén primero el plugin anterior. DSCord conserva el directorio original; no fusiona historiales separados. Un nodo detenido o desconectado no puede ejecutar tareas desde la web.

Para una configuración asistida, usa las [instrucciones para DSH en chino](README.md#dsh-setup) con tu propio servidor, cuenta, rutas y modelos.

<a id="architecture"></a>

## Arquitectura

El servidor compartido gestiona miembros y mensajes. Los Bots se ejecutan en sus propios equipos y se conectan mediante adaptadores de nodo.

| Componente | Función |
| --- | --- |
| **Web / PWA** | Chat, archivos, notificaciones, cuentas y gestión de Bots. |
| **DSCord Core + Matrix / Synapse** | Miembros, salas, mensajes, adjuntos y conexiones de nodos. |
| **DSH + núcleo DSCord** | Conversaciones, herramientas, colaboración y entrega de resultados de cada Bot. |

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
| Configurar modelos y participación | [Modelos y participación](apps/ds-group/模型配置与迁移.md) |
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

## dafeiyu jejeje

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

## Licencia

El código y la documentación originales del producto DSCord en `apps/ds-group/` se distribuyen bajo Apache-2.0. Los componentes de terceros conservan sus propias licencias y avisos. [Licencia del producto](apps/ds-group/LICENSE) · [Avisos de derechos y terceros](apps/ds-group/NOTICE)
