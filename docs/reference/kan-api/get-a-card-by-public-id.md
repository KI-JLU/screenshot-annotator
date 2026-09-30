> ## Documentation Index
> Fetch the complete documentation index at: https://docs.kan.bn/llms.txt
> Use this file to discover all available pages before exploring further.

# Get a card by public ID

> Retrieves a card by its public ID



## OpenAPI

````yaml https://kan.bn/api/v1/openapi.json get /cards/{cardPublicId}
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
  /cards/{cardPublicId}:
    get:
      tags:
        - Cards
      summary: Get a card by public ID
      description: Retrieves a card by its public ID
      operationId: card-byId
      parameters:
        - in: path
          name: cardPublicId
          schema:
            type: string
            minLength: 12
          required: true
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
                  title:
                    type: string
                  description:
                    type: string
                    nullable: true
                  cardNumber:
                    type: number
                    nullable: true
                  index:
                    type: number
                  dueDate:
                    type: string
                    nullable: true
                  createdBy:
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
                  attachments:
                    type: array
                    items:
                      type: object
                      properties:
                        publicId:
                          type: string
                        contentType:
                          type: string
                        s3Key:
                          type: string
                        originalFilename:
                          type: string
                          nullable: true
                        size:
                          type: number
                          nullable: true
                        url:
                          type: string
                          nullable: true
                      required:
                        - publicId
                        - contentType
                        - s3Key
                        - originalFilename
                        - size
                        - url
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
                  list:
                    type: object
                    properties:
                      publicId:
                        type: string
                      name:
                        type: string
                      board:
                        type: object
                        properties:
                          publicId:
                            type: string
                          name:
                            type: string
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
                              required:
                                - publicId
                                - name
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
                        required:
                          - publicId
                          - name
                          - labels
                          - lists
                          - workspace
                    required:
                      - publicId
                      - name
                      - board
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
                            id:
                              type: string
                              nullable: true
                            name:
                              type: string
                              nullable: true
                          required:
                            - id
                            - name
                      required:
                        - publicId
                        - email
                        - user
                  activities:
                    type: array
                    items:
                      type: object
                      properties:
                        publicId:
                          type: string
                        type:
                          type: string
                        createdAt:
                          type: string
                        fromIndex:
                          type: number
                          nullable: true
                        toIndex:
                          type: number
                          nullable: true
                        fromTitle:
                          type: string
                          nullable: true
                        toTitle:
                          type: string
                          nullable: true
                        fromDescription:
                          type: string
                          nullable: true
                        toDescription:
                          type: string
                          nullable: true
                        fromDueDate:
                          type: string
                          nullable: true
                        toDueDate:
                          type: string
                          nullable: true
                        fromList:
                          type: object
                          nullable: true
                          properties:
                            publicId:
                              type: string
                            name:
                              type: string
                            index:
                              type: number
                          required:
                            - publicId
                            - name
                            - index
                        toList:
                          type: object
                          nullable: true
                          properties:
                            publicId:
                              type: string
                            name:
                              type: string
                            index:
                              type: number
                          required:
                            - publicId
                            - name
                            - index
                        label:
                          type: object
                          nullable: true
                          properties:
                            publicId:
                              type: string
                            name:
                              type: string
                          required:
                            - publicId
                            - name
                        member:
                          type: object
                          nullable: true
                          properties:
                            publicId:
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
                              required:
                                - name
                                - email
                          required:
                            - publicId
                            - user
                        user:
                          type: object
                          nullable: true
                          properties:
                            name:
                              type: string
                              nullable: true
                            email:
                              type: string
                          required:
                            - name
                            - email
                        comment:
                          type: object
                          nullable: true
                          properties:
                            publicId:
                              type: string
                            comment:
                              type: string
                            createdBy:
                              type: string
                              nullable: true
                            updatedAt:
                              type: string
                              nullable: true
                            deletedAt:
                              type: string
                              nullable: true
                          required:
                            - publicId
                            - comment
                            - createdBy
                            - updatedAt
                            - deletedAt
                      required:
                        - publicId
                        - type
                        - createdAt
                        - fromIndex
                        - toIndex
                        - fromTitle
                        - toTitle
                        - fromDescription
                        - toDescription
                        - fromDueDate
                        - toDueDate
                        - fromList
                        - toList
                        - label
                        - member
                        - user
                        - comment
                required:
                  - publicId
                  - title
                  - description
                  - cardNumber
                  - index
                  - dueDate
                  - createdBy
                  - labels
                  - attachments
                  - checklists
                  - list
                  - members
                  - activities
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