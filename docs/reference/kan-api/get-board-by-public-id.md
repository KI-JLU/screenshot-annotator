> ## Documentation Index
> Fetch the complete documentation index at: https://docs.kan.bn/llms.txt
> Use this file to discover all available pages before exploring further.

# Get board by public ID

> Retrieves a board by its public ID



## OpenAPI

````yaml https://kan.bn/api/v1/openapi.json get /boards/{boardPublicId}
openapi: 3.0.3
info:
  title: Kan API
  description: OpenAPI compliant REST API
  version: 1.0.0
servers:
  - url: https://kan.bn/api/v1
security: []
tags:
  - name: Auth
  - name: Users
  - name: Boards
  - name: Lists
  - name: Cards
  - name: Labels
  - name: Imports
  - name: Integrations
  - name: Health
externalDocs:
  url: docs.kan.bn
paths:
  /boards/{boardPublicId}:
    get:
      tags:
        - Boards
      summary: Get board by public ID
      description: Retrieves a board by its public ID
      operationId: board-byId
      parameters:
        - in: path
          name: boardPublicId
          schema:
            type: string
            minLength: 12
          required: true
        - in: query
          name: members
          schema:
            type: array
            items:
              type: string
              minLength: 12
        - in: query
          name: labels
          schema:
            type: array
            items:
              type: string
              minLength: 12
        - in: query
          name: lists
          schema:
            type: array
            items:
              type: string
              minLength: 12
        - in: query
          name: dueDateFilters
          schema:
            type: array
            items:
              type: string
              enum:
                - overdue
                - today
                - tomorrow
                - next-week
                - next-month
                - no-due-date
        - in: query
          name: type
          schema:
            type: string
            enum:
              - regular
              - template
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                type: object
                properties:
                  publicId:
                    type: string
                  name:
                    type: string
                  slug:
                    type: string
                  visibility:
                    type: string
                  isArchived:
                    type: boolean
                  favorite:
                    type: boolean
                  workspace:
                    type: object
                    properties:
                      publicId:
                        type: string
                      cardPrefix:
                        type: string
                      members:
                        type: array
                        items:
                          type: object
                          properties:
                            publicId:
                              type: string
                            email:
                              type: string
                            status:
                              type: string
                            user:
                              type: object
                              nullable: true
                              properties:
                                id:
                                  type: string
                                  nullable: true
                                name:
                                  type: string
                                  nullable: true
                                email:
                                  type: string
                                image:
                                  type: string
                                  nullable: true
                              required:
                                - id
                                - name
                                - email
                                - image
                          required:
                            - publicId
                            - email
                            - status
                            - user
                    required:
                      - publicId
                      - cardPrefix
                      - members
                  labels:
                    type: array
                    items:
                      type: object
                      properties:
                        publicId:
                          type: string
                        name:
                          type: string
                        colourCode:
                          type: string
                          nullable: true
                      required:
                        - publicId
                        - name
                        - colourCode
                  lists:
                    type: array
                    items:
                      type: object
                      properties:
                        publicId:
                          type: string
                        name:
                          type: string
                        index:
                          type: number
                        cards:
                          type: array
                          items:
                            type: object
                            properties:
                              publicId:
                                type: string
                              title:
                                type: string
                              description:
                                type: string
                                nullable: true
                              index:
                                type: number
                              cardNumber:
                                type: number
                                nullable: true
                              dueDate:
                                type: string
                                nullable: true
                              labels:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    publicId:
                                      type: string
                                    name:
                                      type: string
                                    colourCode:
                                      type: string
                                      nullable: true
                                  required:
                                    - publicId
                                    - name
                                    - colourCode
                              members:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    publicId:
                                      type: string
                                    email:
                                      type: string
                                    user:
                                      type: object
                                      nullable: true
                                      properties:
                                        name:
                                          type: string
                                          nullable: true
                                        email:
                                          type: string
                                        image:
                                          type: string
                                          nullable: true
                                      required:
                                        - name
                                        - email
                                        - image
                                  required:
                                    - publicId
                                    - email
                                    - user
                              attachments:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    publicId:
                                      type: string
                                  required:
                                    - publicId
                              checklists:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    publicId:
                                      type: string
                                    name:
                                      type: string
                                    index:
                                      type: number
                                    items:
                                      type: array
                                      items:
                                        type: object
                                        properties:
                                          publicId:
                                            type: string
                                          title:
                                            type: string
                                          completed:
                                            type: boolean
                                          index:
                                            type: number
                                        required:
                                          - publicId
                                          - title
                                          - completed
                                          - index
                                  required:
                                    - publicId
                                    - name
                                    - index
                                    - items
                              comments:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    publicId:
                                      type: string
                                  required:
                                    - publicId
                            required:
                              - publicId
                              - title
                              - description
                              - index
                              - cardNumber
                              - dueDate
                              - labels
                              - members
                              - attachments
                              - checklists
                              - comments
                      required:
                        - publicId
                        - name
                        - index
                        - cards
                  allLists:
                    type: array
                    items:
                      type: object
                      properties:
                        publicId:
                          type: string
                        name:
                          type: string
                      required:
                        - publicId
                        - name
                required:
                  - publicId
                  - name
                  - slug
                  - visibility
                  - isArchived
                  - favorite
                  - workspace
                  - labels
                  - lists
                  - allLists
        '400':
          description: Invalid input data
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/error.BAD_REQUEST'
        '401':
          description: Authorization not provided
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/error.UNAUTHORIZED'
        '403':
          description: Insufficient access
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/error.FORBIDDEN'
        '404':
          description: Not found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/error.NOT_FOUND'
        '500':
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/error.INTERNAL_SERVER_ERROR'
      security:
        - Authorization: []
components:
  schemas:
    error.BAD_REQUEST:
      type: object
      properties:
        message:
          type: string
          description: The error message
          example: Invalid input data
        code:
          type: string
          description: The error code
          example: BAD_REQUEST
        issues:
          type: array
          items:
            type: object
            properties:
              message:
                type: string
            required:
              - message
          description: An array of issues that were responsible for the error
          example: []
      required:
        - message
        - code
      title: Invalid input data error (400)
      description: The error information
      example:
        code: BAD_REQUEST
        message: Invalid input data
        issues: []
    error.UNAUTHORIZED:
      type: object
      properties:
        message:
          type: string
          description: The error message
          example: Authorization not provided
        code:
          type: string
          description: The error code
          example: UNAUTHORIZED
        issues:
          type: array
          items:
            type: object
            properties:
              message:
                type: string
            required:
              - message
          description: An array of issues that were responsible for the error
          example: []
      required:
        - message
        - code
      title: Authorization not provided error (401)
      description: The error information
      example:
        code: UNAUTHORIZED
        message: Authorization not provided
        issues: []
    error.FORBIDDEN:
      type: object
      properties:
        message:
          type: string
          description: The error message
          example: Insufficient access
        code:
          type: string
          description: The error code
          example: FORBIDDEN
        issues:
          type: array
          items:
            type: object
            properties:
              message:
                type: string
            required:
              - message
          description: An array of issues that were responsible for the error
          example: []
      required:
        - message
        - code
      title: Insufficient access error (403)
      description: The error information
      example:
        code: FORBIDDEN
        message: Insufficient access
        issues: []
    error.NOT_FOUND:
      type: object
      properties:
        message:
          type: string
          description: The error message
          example: Not found
        code:
          type: string
          description: The error code
          example: NOT_FOUND
        issues:
          type: array
          items:
            type: object
            properties:
              message:
                type: string
            required:
              - message
          description: An array of issues that were responsible for the error
          example: []
      required:
        - message
        - code
      title: Not found error (404)
      description: The error information
      example:
        code: NOT_FOUND
        message: Not found
        issues: []
    error.INTERNAL_SERVER_ERROR:
      type: object
      properties:
        message:
          type: string
          description: The error message
          example: Internal server error
        code:
          type: string
          description: The error code
          example: INTERNAL_SERVER_ERROR
        issues:
          type: array
          items:
            type: object
            properties:
              message:
                type: string
            required:
              - message
          description: An array of issues that were responsible for the error
          example: []
      required:
        - message
        - code
      title: Internal server error error (500)
      description: The error information
      example:
        code: INTERNAL_SERVER_ERROR
        message: Internal server error
        issues: []
  securitySchemes:
    Authorization:
      type: http
      scheme: bearer

````