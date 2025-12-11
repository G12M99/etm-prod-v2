# GEMINI.md - ETM Prod V2

## Project Overview

This project is a high-fidelity, interactive mockup of a production planning application named "ETM PROD V2". It is a single-page web application built with vanilla HTML5, CSS3, and JavaScript (ES6+). The application is designed for a sheet metal workshop and provides a user interface for scheduling production tasks across various machines.

The core functionalities include:
-   **Dual Views:** A weekly overview of the machine load and a detailed daily schedule.
-   **Drag & Drop:** Operations can be moved between machines and time slots in the daily view.
-   **Automatic Calculation:** The duration of each operation (shearing, punching, bending) is automatically calculated based on the weight of the material.
-   **Order Management:** A sidebar lists unplaced orders, which can be automatically or manually placed on the schedule.
-   **Capacity Gauges:** Visual indicators show the workload of each machine.

The entire application logic is client-side and contained within `app.js`, which also includes the demo data. The project is self-contained and has no external dependencies other than Google Fonts.

## Building and Running

This is a static web project with no build process required.

### Running the Application

To run the application, simply open the `index.html` file in a modern web browser.

On Windows, you can use the following command in the project's root directory:
```bash
start index.html
```

## Development Conventions

### Code Style

-   **HTML:** The `index.html` file is well-structured, using semantic HTML5 tags.
-   **CSS:** The `styles.css` file is organized and uses CSS variables for theming (colors, spacing, typography), making it easy to customize the look and feel. The layout is built using Flexbox and CSS Grid and is responsive.
-   **JavaScript:** The `app.js` file is written in modern JavaScript (ES6+) and is extensively commented. The code is structured into logical sections: configuration, demo data, utility functions, UI rendering functions for each view, and event handlers. Critical business logic, such as the production order constraints, is clearly marked and explained.

### Project Structure

The project follows a simple and clear structure:
```
ETM Prod/
├── index.html          # Main HTML file (the user interface)
├── styles.css          # All styles for the application
├── app.js              # All application logic and demo data
└── README.md           # Detailed project documentation
```

### Key Files

-   `index.html`: The entry point of the application. It defines the structure of the page, including the different views and modals.
-   `styles.css`: Contains all the styling for the application. It is well-organized and uses variables for easy customization.
-   `app.js`: The heart of the application. It contains all the logic for rendering the views, handling user interactions (like drag and drop), calculating durations, and managing the demo data.
