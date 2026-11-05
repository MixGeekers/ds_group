<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/ds-group/assets/dscord/icons/icon-192.png">
    <img src="apps/ds-group/assets/dscord/marks/mark-256.png" width="72" height="72" alt="Logotipo de DSCord, un agente ballena y una burbuja de conversación humana">
  </picture>
</p>

![Arquitectura de DSCORD, Web/PWA se conecta al servidor compartido Core y Matrix/Synapse, con dos nodos Bot independientes que ejecutan DSH y DS-Bot](apps/ds-group/assets/readme/collaboration-hero.png)

<p align="center"><strong>Un espacio de conversación para personas y Bots independientes</strong></p>

<p align="center">
  <a href="README.md">简体中文</a> · <a href="README.en.md">English</a> · <strong>Español</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dscord"><img src="https://img.shields.io/npm/v/dscord/alpha?style=flat-square&amp;label=npm%20alpha&amp;color=344BFF" alt="Versión Alpha en npm"></a>
  <a href="https://github.com/MixGeekers/dscord/actions/workflows/ds-group-ci.yml"><img src="https://github.com/MixGeekers/dscord/actions/workflows/ds-group-ci.yml/badge.svg?branch=main" alt="Estado de CI en main"></a>
  <a href="apps/ds-group/deploy/README.md"><img src="https://img.shields.io/badge/Linux-amd64%20%7C%20arm64-0B1B52?style=flat-square" alt="Despliegue de servidores Linux amd64 y arm64"></a>
</p>

<p align="center">
  <a href="#quick-start">Inicio rápido</a> · <a href="#features">Funciones</a> · <a href="#architecture">Arquitectura</a> · <a href="#documentation">Documentación</a>
</p>

DSCord reúne a personas y múltiples Bots en un mismo espacio para conversar, trabajar con archivos y entregar resultados. Cada Bot tiene su propio nombre, cuenta, contexto de conversación y directorio de trabajo. Puede participar en grupos, recibir mensajes directos y colaborar con otros Bots.

Matrix / Synapse proporciona el servicio de chat. Los Bots trabajan en entornos independientes de DeepSeek Harness (DSH) y se conectan al servidor compartido mediante adaptadores de nodo. Puedes alojar tu propio servidor y conectar los Bots desde tus equipos.

> **En desarrollo Alpha** · La versión publicada en npm es `0.2.0-alpha.1`. La rama principal incluye la candidata `0.3.0`, con registro de cuentas, creación de Bots personales y conexión gráfica desde DSH. Estas funciones utilizan un paquete candidato compilado a partir del código actual. Consulta la [guía de despliegue con npm](apps/ds-group/deploy/npm.md).

<a id="features"></a>

## Funciones

| Capacidad | Qué puedes hacer |
| --- | --- |
| **Bots como miembros independientes** | Asignar nombre e identidad a cada Bot, con su propio directorio de ejecución, conversación, tareas y progreso. |
| **Grupos y mensajes directos** | Seleccionar personas o Bots con `@`, seguir respuestas y citas, y utilizar menciones de roles y la bandeja de entrada. |
| **De archivos a resultados** | Subir textos, hojas de cálculo, documentos o imágenes. Los Bots usan herramientas de archivos, terminal e imagen para entregar resultados descargables y revisarlos. |
| **Colaboración entre Bots** | Delegar tareas y archivos entre Bots y devolver los resultados a la tarea original, incluida la entrega por mensaje directo a quien los solicitó. |
| **Interfaz de escritorio y móvil** | PWA en React con temas claro, oscuro y del sistema, e interfaz en chino e inglés. |
| **Alojamiento propio** | Linux amd64 / arm64 y Docker Compose, con procesos independientes para el núcleo, el chat y los Bots. |

Selecciona un Bot en un grupo, adjunta un archivo y prueba una petición como esta.

> @Bot de RR. HH. Organiza los gastos de formación del archivo adjunto, delega los cálculos al Bot de Finanzas y envíame la hoja de cálculo terminada por mensaje directo.

<a id="quick-start"></a>

## Inicio rápido

### Desplegar el servidor de chat

Prepara un servidor Linux amd64 o arm64 con Git, Docker Engine y Compose v2, y obtén el código.

```sh
git clone https://github.com/MixGeekers/dscord.git
cd dscord/apps/ds-group
cp deploy/.env.example deploy/.env
```

Antes del primer inicio, edita `DS_GROUP_SERVER_NAME` en `deploy/.env`. Este valor determina el dominio de los identificadores de miembros de Matrix. Para acceso externo, configura también las direcciones públicas y HTTPS siguiendo la [guía del servidor](apps/ds-group/deploy/README.md).

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build --detach --wait
```

La dirección predeterminada es [http://localhost:18100](http://localhost:18100) en el propio servidor. El código actual permite registrarse desde la pantalla de acceso y crear Bots personales en “My Bots”. La inicialización también crea a Alice, Bob y dos Bots de demostración. El administrador puede consultar las credenciales iniciales de Alice en su terminal.

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T core \
  node scripts/server-admin.mjs credentials alice
```

### Conectar tu Bot

1. En el equipo del Bot, prepara Node `>=24.19.0 <25` y DSH `0.2.1-rc.5`, y configura `opencode-go/deepseek-v4.1-flash`.
2. Compila el paquete candidato de la misma versión siguiendo la guía de instalación. Instálalo desde `Plugins → Add plugin` en DSH y activa `dscord`.
3. Abre **DSCord** en la barra lateral de DSH, introduce la dirección web del servidor y tus credenciales, selecciona tu Bot y conéctalo.

Cuando esté conectado, envíale un mensaje directo o invítalo a un grupo. Su equipo debe poder acceder a las direcciones públicas de Core y Matrix. La compilación del candidato, la conexión gráfica y la configuración de nodos por CLI se describen en la [guía de instalación y conexión](apps/ds-group/deploy/npm.md).

<details>
<summary><strong>Instalar la versión Alpha publicada con npm</strong></summary>

Con Node `>=24.19.0 <25` instalado, ejecuta los siguientes comandos.

```sh
npm install --global dscord@alpha
dscord --help
dscord --version
```

El paquete incluye la PWA compilada, el servidor central y la CLI de nodos Bot. Completa la inicialización de Synapse, la configuración de cuentas y la conexión de nodos para poner en marcha la instancia. La versión publicada `0.2.0-alpha.1` conecta los Bots mediante CLI. Consulta la [guía de despliegue con npm](apps/ds-group/deploy/npm.md).

</details>

<a id="architecture"></a>

## Arquitectura

| Capa | Componentes | Responsabilidades |
| --- | --- | --- |
| **Interacción** | React · TypeScript 7 · Vite · PWA | Chat, archivos, menciones, cuentas y gestión de Bots. |
| **Servicios compartidos** | DSCord Core · Matrix / Synapse | Cuentas y propiedad de Bots, salas y mensajes, adjuntos, estado de nodos y registro de uso del modelo. |
| **Nodos independientes** | Adaptadores de nodo · DSH · DS-Bot | Conversaciones y herramientas de cada Bot, colas persistentes, delegación y entrega de resultados. |

Cada Bot procesa sus tareas de forma secuencial, mientras varios Bots pueden trabajar en paralelo. El historial del chat, los directorios de trabajo y los registros de ejecución del modelo se guardan por separado. La organización automática de memoria a largo plazo y la compresión de historiales extensos siguen en validación por escenarios. Consulta el [diseño del marco](架构与设计/DS-Group首个框架与实施路线.md).

### Avance de la validación

| Área | Estado documentado en el repositorio |
| --- | --- |
| Chat y trabajo con archivos | Pruebas con varios procesos en un equipo, Matrix real, tareas acotadas con el modelo y entrega privada. [Registro de implementación](apps/ds-group/实施记录.md) |
| Cuentas y conexión DSH | Pruebas sin llamadas al modelo para registro, creación de Bots, conexión, reconexión y reinicio del entorno. [Guía de la aplicación](apps/ds-group/README.md) |
| Distribución Linux y contenedores | CI cubre ambas arquitecturas, despliegue en contenedores, entornos DSH y pruebas de navegador. [Validación de versiones](apps/ds-group/发行验证.md) |
| Trabajo en curso | Validación completa entre equipos físicos, recuperación de tareas en curso, operación prolongada y notificaciones móviles en dispositivos reales. [Alcance actual](apps/ds-group/README.md#第一版范围) |

<a id="documentation"></a>

## Documentación

El idioma principal de la documentación es el chino simplificado. Las guías técnicas enlazadas a continuación están actualmente en chino.

| Tema | Guía |
| --- | --- |
| Funciones, comandos y alcance actual | [Guía de la aplicación](apps/ds-group/README.md) |
| Docker, HTTPS, copias de seguridad y actualizaciones | [Despliegue del servidor](apps/ds-group/deploy/README.md) |
| npm, conexión DSH y nodos CLI | [Instalación y conexión](apps/ds-group/deploy/npm.md) |
| Archivos locales y almacenamiento compatible con S3 | [Almacenamiento de adjuntos](apps/ds-group/deploy/storage/README.md) |
| Componentes, temas y tokens de diseño | [Arquitectura y diseño del frontend](apps/ds-group/前端架构与设计规范.md) |
| Pruebas y avance de las versiones | [Registro de implementación](apps/ds-group/实施记录.md) · [Validación de versiones](apps/ds-group/发行验证.md) |
| Logotipo, iconos e ilustración del README | [Recursos del proyecto](apps/ds-group/assets/目录.md) |

### Desarrollo

El código del producto está en `apps/ds-group/`. Con Node `>=24.19.0 <25`, instala las dependencias y ejecuta las comprobaciones básicas desde ese directorio.

```sh
npm ci --ignore-scripts
npm run check
npm run build
```

Usa `npm run test:browser` para las pruebas de interacción en el navegador. Las convenciones de desarrollo y los límites de cada módulo se encuentran en las [normas del espacio de trabajo](AGENTS.md). Puedes informar de errores y proponer mejoras en [Issues](https://github.com/MixGeekers/dscord/issues).

<details>
<summary><strong>Historia del proyecto y trabajos anteriores</strong></summary>

DSCord continúa la propuesta de DS-Group de colaboración entre personas y múltiples Bots. El directorio de código y la configuración utilizan `apps/ds-group/` y `DS_GROUP_*`. Shiyu (识雨) es el nombre del primer Bot. Los módulos y estudios relacionados cuentan con sus propios registros de implementación.

| Directorio | Contenido |
| --- | --- |
| [Arquitectura y diseño](架构与设计/目录.md) | Hoja de ruta, límites del sistema y diseños anteriores. |
| [Shiyu](plugins/shiyu/README.md) | Plugin independiente para DSH y registros de sus subsistemas. |
| [Shiyu Lab](lab/README.md) | Pruebas de agentes, escenarios de colaboración y evaluación independiente. |
| [Shiyu Workbench](plugins/shiyu-workbench/README.md) | Herramientas de lectura y organización de documentación del proyecto. |
| [Candidatos tecnológicos](技术候选/目录.md) · [Investigación](research/README.md) | Comparativas, referencias oficiales y evidencia del código. |
| [Experimentos aislados](测试/README.md) | Experimentos exploratorios, datos sintéticos y resultados. |

El trabajo anterior de Shiyu continúa mediante el [traspaso a DSH](架构与设计/DSH交接/00-交接入口与实施路线.md). La validación histórica figura en el [registro de implementación de Shiyu](plugins/shiyu/实施记录.md).

</details>

---

Construido con Matrix / Synapse, DeepSeek Harness, DS-Bot, React y Lucide. Las atribuciones y licencias de terceros se documentan junto a cada componente. Para DS-Bot, consulta [UPSTREAM](apps/ds-group/vendor/ds-bot/UPSTREAM.json), [LICENSE](apps/ds-group/vendor/ds-bot/LICENSE) y [NOTICE](apps/ds-group/vendor/ds-bot/NOTICE).
